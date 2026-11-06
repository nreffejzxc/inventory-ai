# 2. Running and mirroring Inventory AI on a phone

Runs the app on a real Android phone, loading code from *this* laptop and talking to *this* laptop's
backend. For a cable-free session, use the verified [wireless phone session](15-wireless-phone-session.md);
it starts the same backend and Metro and uses the same development build.

## The four pieces

| Piece | Plain words | If missing |
|---|---|---|
| **adb** | The USB bridge that lets the laptop command the phone | The laptop cannot see the phone |
| **A development build** | An app build that fetches its code from the laptop | The app opens but ignores your edits |
| **Metro** | The part of `npx expo start` that serves the code | "Cannot connect" screen |
| **The backend** | Holds the rules and data | Screens load, every action fails |

A store build **cannot** load code from the laptop — its code is sealed in. Only a development build
can, which is why an app that ignores your edits is almost always the wrong build.

## Step 1 — install the USB tool (once ever)

In **PowerShell**, not WSL:

```powershell
adb version
winget install --id Google.PlatformTools -e    # only if not recognised
```

Then **open a new terminal window** — an open window does not see the installer's updated PATH. On
this machine `adb` is at `C:\Users\jeffe\AppData\Local\Android\Sdk\platform-tools\adb.exe`.

## Step 2 — enable USB debugging (once per phone)

1. **Settings → About device** → tap **Build number** seven times (OPPO/ColorOS: *Version*).
2. **Settings → System settings → Developer options** (OPPO: often *Additional settings*) → **USB
   debugging** on, and **Stay awake** on.

## Step 3 — plug in and authorise (once per laptop)

Use a data cable. Accept *"Allow USB debugging?"* with **Always allow from this computer**. No prompt?
Pull down the shade, tap the USB notification, choose **File transfer**, replug. Then:

```bash
adb devices
```

| Prints | Meaning | Do |
|---|---|---|
| `PV4DDMIZZLTCIVSK   device` | Working | Continue |
| `...   unauthorized` | Prompt not accepted | Accept, or *Revoke USB debugging authorizations* and replug |
| `...   offline` | Stale connection | `adb reconnect`, or `adb kill-server` and replug |
| *(nothing)* | Phone invisible | Cable, port, USB mode, USB debugging off |

**Do not continue until it says `device`.**

## Before Step 4 — does the build have its settings?

A phone build is assembled in EAS from `mobile/eas.json` **and** the **EAS environment** for that
profile, and a missing setting does not fail a build — the trap. (On 2026-10-15 the `production`
environment was empty, so a production build had no Firebase settings and silently used the old
password path.)

```bash
cd C:/Users/jeffe/inventory-ai/mobile
node scripts/check-build-env.mjs --live     # exits 1 and names every missing setting
```

Exit 0 means every setting that profile needs is present. What it checks, and which EAS variable each
one comes from: [Guide 6](6-scripts-and-commands.md) (the command) and
[Guide 7 § EAS environments](7-over-the-air-updates.md) (the variables). The host's own settings live
in its dashboard (Render → Environment), never in this project.

## Step 4 — put a development build on the phone

```bash
cd C:/Users/jeffe/inventory-ai/mobile
eas build --profile development --platform android
adb install -r "C:\path\to\the-downloaded.apk"
```

- Installing it **replaces** the normal app and vice versa (same `com.inventoryai.app`); app data is kept.
- Do **not** use `npx expo run:android` — it creates a native `android/` folder this project keeps out
  of the repository.

Check which build is installed:

```bash
adb shell cmd package resolve-activity --brief -a android.intent.action.VIEW -d "inventoryai://expo-development-client/?url=http://localhost:8081"
```

`com.inventoryai.app/.MainActivity` means the right build; *No activity found* means a finished build.

## Step 5 — start the backend (window 1)

```bash
cd C:/Users/jeffe/inventory-ai/server
npm start
```

Everything the phone asks for is printed here — that is how you prove the phone reaches *your* laptop.

## Step 6 — the USB tunnels, then Metro (window 2)

`mobile/.env` says `EXPO_PUBLIC_API_URL=http://localhost:4000`, but on the phone `localhost` is the
phone. `adb reverse` forwards the phone's own ports to the laptop:

```bash
adb reverse tcp:8081 tcp:8081     # phone localhost:8081 -> laptop Metro
adb reverse tcp:4000 tcp:4000     # phone localhost:4000 -> laptop backend
adb reverse --list                # MUST list both
```

```bash
cd C:/Users/jeffe/inventory-ai/mobile
npx expo start --dev-client --clear
```

Expo creates the `8081` tunnel itself, so the app loads and looks healthy; **nothing creates
`4000`**. That is why the app can run until it does anything, then say *"Cannot reach the server"*.
Tunnels vanish on any replug or `adb` restart — `adb reverse --list` is the first thing to check.

## Step 7 — open the app

```bash
adb shell am start -a android.intent.action.VIEW \
  -d "inventoryai://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
```

Pressing **`a`** in the Metro window is the shortcut; the command above is the tested path.

## Step 8 — prove it worked

| Signal | Where | Proves |
|---|---|---|
| `Android Bundled <n>ms node_modules\expo-router\entry.js (1602 modules)` | Metro window | the phone fetched code from **this** laptop |
| `mResumedActivity: ... com.inventoryai.app/.MainActivity` | `adb shell dumpsys activity activities` | the app is on screen, not a crash dialog |
| a new `{"type":"http", ...}` line | backend window | the phone reached **this** laptop's API |

If the first two pass and the third stays silent, the app is pointed elsewhere: re-check
`mobile/.env`, then restart Metro with `--clear`. Test the tunnel without the app:

```bash
adb shell am start -a android.intent.action.VIEW -d "http://localhost:4000/api/health/live"
```

## Step 9 — working

| Want | Do |
|---|---|
| See edits | save the file; press **`r`** in Metro to force a reload |
| Developer menu | shake the phone, or `adb shell input keyevent 82` |
| App logs | the Metro window |
| Stop | `Ctrl+C` in each window |

## Step 10 — optional: mirror the phone

Mirroring shows the phone screen in a laptop window and lets the laptop's mouse and keyboard control it.
This is the USB path; for a cable-free session use [Guide 15](15-wireless-phone-session.md). Mirroring
rides on `adb`, so if `adb` cannot see the phone, scrcpy cannot either.

### Install scrcpy (once ever)

Install `adb` and authorize the phone with Steps 1–3 first. Then install scrcpy in **PowerShell** or
**Windows Terminal**, not WSL (WSL cannot see USB devices):

```powershell
scrcpy --version
winget install --id Genymobile.scrcpy -e --accept-source-agreements --accept-package-agreements
```

**Open a new terminal window afterwards** — an open window does not see the installer's updated program
list, which is the usual cause of "installed but not recognised".

### Start and prove it

Use its own terminal window; closing that window stops the mirror.

```bash
scrcpy -s PV4DDMIZZLTCIVSK -m 1024 --window-title "Inventory AI"
```

| Part | Does |
|---|---|
| `-s PV4DDMIZZLTCIVSK` | Target this phone (`-d` means "the one on USB") |
| `-m 1024` | Shrink the long edge to 1024 px |
| `--window-title "Inventory AI"` | Name the window |

A window appearing is not proof. A real run prints:

```text
INFO: ADB device found:
INFO:     -->   (usb)  PV4DDMIZZLTCIVSK   device  CPH1969
[server] INFO: Device: [OPPO] OPPO CPH1969 (Android 11)
INFO: Texture: 472x1024
```

`INFO: Texture: <width>x<height>` means frames are arriving. Double-check from another window:

```bash
adb shell ps -A | findstr app_process   # two shell-owned entries = scrcpy helper running
```

Extras: `--no-audio` (no audio stream), `--record=session.mp4` (save a video for bug reports), and `-w`
(keep the phone awake — on OPPO/Realme/Vivo this needs *"USB debugging (Security settings)"* enabled, so
prefer the *Stay awake* toggle from Step 2).

### Controls

| Phone | Laptop |
|---|---|
| Finger / tap / swipe | mouse / left-click / click-drag |
| Type text | type with a field focused |
| Back | right-click · `Alt+b` · `Alt+Backspace` |
| Home | middle-click · `Alt+h` |
| Recent apps | 4th mouse button · `Alt+s` |
| Notification panel | 5th mouse button · `Alt+n` |
| Screen off / on | `Alt+o` / `Alt+Shift+o` |
| Rotate | `Alt+r` |
| Fullscreen | `Alt+f` or `F11` |
| 1:1 pixels | `Alt+g` |
| Quit | `Alt+q` |

Drag an `.apk` onto the window to install it — a convenient alternative to typing
`adb install thefile.apk`. `scrcpy --help` lists every shortcut.

### Mirroring problems

| What you see | Cause | Do |
|---|---|---|
| `scrcpy` not recognised | Terminal predates the install | Open a new terminal |
| Window opens then closes | No device, or authorisation | Read the last printed lines |
| Window is black | Screen off, or a secure screen | Wake the phone; some secure screens never mirror |
| Window wrong size | `-m` value | `-m 1024`, full size, or `Alt+g` |
| Clicks land wrong | Orientation mismatch | `Alt+r` |

## Everyday routine

```bash
adb devices
scrcpy -s PV4DDMIZZLTCIVSK -m 1024 --window-title "Inventory AI"   # optional mirror
adb reverse tcp:8081 tcp:8081
adb reverse tcp:4000 tcp:4000
adb reverse --list

cd C:/Users/jeffe/inventory-ai/server && npm start
cd C:/Users/jeffe/inventory-ai/mobile && npx expo start --dev-client
```

Then open the app with the Step 7 command.

## If something goes wrong

| What you see | Cause | Do |
|---|---|---|
| *"Cannot reach the server"* | `4000` tunnel missing | `adb reverse tcp:4000 tcp:4000`, then `--list` |
| App ignores edits | Finished build, not a development build | Redo Step 4, check with `resolve-activity` |
| `unauthorized` | Prompt not accepted | Unlock and accept; may reappear after an `adb` restart |
| `offline` | Stale connection | `adb reconnect`, or `adb kill-server` and replug |
| Empty `adb devices` | Cable/port/USB mode/debugging | Another cable and port; recheck Step 2 |
| Metro says 8081 in use | Another Metro running | Let Expo pick another port, or stop the other |
| Red error screen | Real code error | Read the message in the Metro window |
| Worked yesterday | Cable bumped / laptop slept | `adb devices`, then both `adb reverse` lines |

Deep reference: [docs/DEVELOPING_ON_A_PHYSICAL_DEVICE.md](../DEVELOPING_ON_A_PHYSICAL_DEVICE.md)
(exact observed outputs from a real OPPO CPH1969 run).

← [Guides index](README.md) · Next: [4. Test accounts and mock data](4-test-accounts-and-mock-data.md)
