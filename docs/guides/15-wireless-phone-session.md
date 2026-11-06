# 15. A wireless phone session — start to finish

Runs Inventory AI on an Android phone and mirrors it to this laptop over Wi-Fi. No cable and no build:
the installed Expo **development build** is already on the phone. Do not run `eas build` or
`npx expo run:android` just to start a session.

Verified on 2026-11-06 on an OPPO CPH1969 running Android 11. The serial and address below come from that
session; replace them with the values from Part A. This assumes `server/.env`, `mobile/.env` and the
installed dependencies already exist. It does not change either env file, seed data, or build the app.

## One command (recommended)

From the repository root:

```bash
cd C:/Users/jeffe/inventory-ai
node scripts/device/wireless.mjs
```

The helper:

1. finds the wireless ADB phone, or connects automatically when exactly one `_adb._tcp` service is
   advertised;
2. recreates the `8081` and `4000` reverse tunnels;
3. reuses a healthy backend and Metro, starting either one only if it is missing;
4. opens the installed development client; and
5. starts scrcpy and stays attached to it.

It is safe to run when a session is already up: healthy services are reused and an existing scrcpy
window is left untouched. It never installs or builds the app. If the local ADB server has stopped
answering, the helper restarts it once at startup; `--check` never restarts anything.

```bash
node scripts/device/wireless.mjs --check
# read-only report: wireless adb, tunnels, backend, Metro, app, mirror

node scripts/device/wireless.mjs --serial=192.168.1.2:5555
# choose the device when more than one wireless phone is attached

node scripts/device/wireless.mjs --stop
# stop the session this helper started, from a second terminal

node scripts/device/wireless.mjs --self-test
# simulate recovery, restart failure, and stop; no phone needed

node scripts/device/wireless.mjs --help
```

Keep the terminal open while the mirror is open. **Ctrl+C or `--stop` stops the backend, Metro and
scrcpy that this helper started**; services that were already running are left alone. It prints the
temp-folder path holding each service's log.

The helper cannot enable wireless ADB. If it reports that no device is attached, do **Part A** once
over USB. The manual procedure below is the fallback when a service is unhealthy or you want each
step in its own terminal.

## What the tunnels do

```text
wireless ADB → reverse tunnels → backend → Metro → launch app → start scrcpy
```

The reverse tunnels are what make the phone's `localhost:8081` and `localhost:4000` mean **this laptop**.
They are not created by Expo, and they disappear when the wireless ADB connection is lost.

## Part A — one-time setup, or after the phone reboots

Does `adb devices -l` already list `192.168.1.2:5555   device`? If yes, skip to Part B. If the phone
has rebooted, or `adb connect` is refused, use the USB cable once:

```bash
cd C:/Users/jeffe/inventory-ai

# 1. The cable must be a data cable, USB debugging on, prompt accepted.
adb devices -l
# Expect: PV4DDMIZZLTCIVSK   device

# 2. Put the phone's adb daemon into TCP mode on port 5555.
adb -s PV4DDMIZZLTCIVSK tcpip 5555
# Expect: restarting in TCP mode port: 5555

# 3. Read the phone's current Wi-Fi address.
adb -s PV4DDMIZZLTCIVSK shell ip -f inet addr show wlan0
# Look for: inet 192.168.1.2/24
```

If step 3 says the device is not found, unplug and replug the USB cable, then run step 3 again. The
`adb tcpip` command deliberately restarts the phone-side daemon, so a short disappearance is normal.

```bash
# 4. Connect over Wi-Fi. Use the address from step 3.
adb connect 192.168.1.2:5555
adb devices -l
# Both the USB serial and 192.168.1.2:5555 may be listed. That is normal.

# 5. Unplug the cable now, then prove the remaining connection is wireless.
adb -s 192.168.1.2:5555 shell getprop ro.serialno
# Expect: PV4DDMIZZLTCIVSK
```

`adb -s 192.168.1.2:5555` names the **wireless** connection. `-d` means "the one on USB" and is the wrong
target here.

### If the phone's Wi-Fi address changed

The address is assigned by the router; `192.168.1.2` is not permanent. First try:

```bash
adb mdns services
# Expect a line such as:
# adb-PV4DDMIZZLTCIVSK   _adb._tcp   192.168.1.2:5555
```

Use the address on the `_adb._tcp` line. If mDNS shows nothing, plug in USB and repeat Part A. Android
11's **Developer options → Wireless debugging** can show the current address and supports
`adb pair <ip>:<port>` with a pairing code, but the verified path on this phone is port `5555` through
`adb tcpip`.

## Part B — every wireless session

Open three terminals in the project. Run them in this order.

### 1. Confirm the wireless connection

```bash
adb devices -l
```

If `192.168.1.2:5555` is not listed:

```bash
adb connect 192.168.1.2:5555
adb devices -l
```

Do not continue until the wireless line says `device`, not `offline` or `unauthorized`.

### 2. Create the two reverse tunnels

```bash
adb -s 192.168.1.2:5555 reverse tcp:8081 tcp:8081
adb -s 192.168.1.2:5555 reverse tcp:4000 tcp:4000
adb -s 192.168.1.2:5555 reverse --list
```

`reverse --list` must show **both**:

```text
host-… tcp:8081 tcp:8081
host-… tcp:4000 tcp:4000
```

`8081` is Metro (the JavaScript). `4000` is the backend API. Re-run both commands after any reconnect;
an old tunnel does not survive a new ADB connection.

### 3. Start the backend — terminal 1

```bash
cd C:/Users/jeffe/inventory-ai/server
npm start
```

Wait for the database line and `[server] environment=development listening on http://localhost:4000`.
Leave this window open; it is the backend log you use to prove the phone reached this laptop.

### 4. Start Metro — terminal 2

```bash
cd C:/Users/jeffe/inventory-ai/mobile
npx expo start --dev-client --localhost --port 8081 --clear
```

Wait for `Waiting on http://localhost:8081`. Check it without waiting for the phone:

```bash
curl -s http://localhost:8081/status
# packager-status:running
```

`--localhost` is deliberate. The phone cannot reach the laptop's `localhost` directly; the `tcp:8081`
reverse tunnel carries the phone's `localhost:8081` to this Metro process.

### 5. Launch Inventory AI — terminal 3

```bash
adb -s 192.168.1.2:5555 shell am start -a android.intent.action.VIEW \
  -d "inventoryai://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
```

The URL is percent-encoded on purpose. This opens the installed development client on the Metro server;
it does not install or rebuild anything.

If the app cold-starts into the **development launcher** instead of Inventory AI, this is the command
that selects the server. A normal app deep link cannot start a stopped dev client.

### 6. Start the mirror — terminal 3, or its own window

```bash
scrcpy -s 192.168.1.2:5555 -m 1024 --window-title "Inventory AI" --no-audio
```

Leave that terminal open; closing it stops scrcpy. The lines to look for are:

```text
INFO: ADB device found:
INFO:     --> (tcpip)  192.168.1.2:5555   device  CPH1969
INFO: Texture: <width>x<height>
```

The scrcpy window is now the phone: mouse clicks are taps, the keyboard types, and the window can be
resized. `Alt+q` quits; `Alt+f` is fullscreen.

## How to verify the session

| Check | Command / place | Passing answer |
|---|---|---|
| Wireless ADB | `adb devices -l` | `192.168.1.2:5555   device` |
| Both tunnels | `adb -s 192.168.1.2:5555 reverse --list` | `tcp:8081` **and** `tcp:4000` |
| Backend | `curl -s http://localhost:4000/api/health/ready` | `{"status":"ready","db":"connected"…}` |
| Metro | `curl -s http://localhost:8081/status` | `packager-status:running` |
| JS reached phone | Metro window | `Android Bundled … node_modules\expo-router\entry.js` |
| App is foreground | `adb -s 192.168.1.2:5555 shell dumpsys activity activities \| grep mResumedActivity` | `com.inventoryai.app/.MainActivity` |
| Frames arriving | scrcpy window | `INFO: Texture: <width>x<height>` |
| UI rendered | scrcpy window | **Sign In** screen, or the dashboard if already signed in |

### Prove the phone can reach the backend

The sign-in screen alone does not call the API. To test the `4000` tunnel from the phone:

```bash
adb -s 192.168.1.2:5555 shell am start -a android.intent.action.VIEW \
  -d "http://localhost:4000/api/health/live"
```

The backend window must log a `GET /api/health/live` with status `200`. A laptop `curl` alone does
**not** prove the phone tunnel. Close the browser and relaunch the app with the Step 5 command.

## Stop the session

### Session started by the helper

```bash
cd C:/Users/jeffe/inventory-ai
node scripts/device/wireless.mjs --stop
```

This is the normal way to stop a helper-owned session from a second terminal. It asks the running
helper to close the mirror, stop the backend and Metro it started, and remove its state file. It waits
up to 15 seconds for the helper to exit. If no managed session is running, it reports that and exits
successfully. Manually started services are not touched.

### Manual session

```bash
# In the scrcpy window: Alt+q, or close the window.
# Then Ctrl+C in the Metro and backend terminals.
adb disconnect 192.168.1.2:5555
```

`adb disconnect` does not uninstall anything or change app data. The next session starts again at
Part B; the reverse tunnels must be created again.

## If something goes wrong

| What you see | Cause | Do |
|---|---|---|
| `more than one device/emulator` | both USB and wireless are attached | add `-s 192.168.1.2:5555` to every adb command |
| `failed to connect … 5555` | phone asleep, wrong IP, or TCP mode off after reboot | wake and unlock; `adb mdns services`; if none, redo Part A with USB |
| `unauthorized` | debugging prompt was not accepted | unlock the phone, accept **Always allow**, or revoke/reauthorize |
| `spawnSync adb ETIMEDOUT` | stale ADB server, seen occasionally after a session ends | the helper restarts it automatically at startup; if it still fails, end `adb.exe`, then `adb start-server`, `adb connect 192.168.1.2:5555`, and rerun |
| `reverse --list` is empty | connection was recreated | run both `adb reverse` commands again |
| Metro says `8081 in use` | old Metro process | stop the old one, or change both the Metro port and the `8081` reverse |
| App opens the development launcher | Metro was not ready, or the launch command was skipped | confirm `packager-status:running`, then run Step 5 |
| App says *Cannot reach the server* | `4000` tunnel missing, or backend stopped | `reverse --list`, `curl …/api/health/ready`, redo the tunnel |
| scrcpy is missing, black, or will not start | install/terminal issue, or a secure screen | see [Guide 2, Step 10](2-run-on-your-phone.md); wake and unlock |
| `Could not parse Expo config: google-services.json` | those files are EAS-managed and absent locally | harmless; ignore |
| Changes do not appear | Metro is serving the old bundle | save the file, press `r` in Metro, or restart with `--clear` |

## Is this still a development build?

```bash
adb -s 192.168.1.2:5555 shell cmd package resolve-activity --brief \
  -a android.intent.action.VIEW \
  -d "inventoryai://expo-development-client/?url=http://localhost:8081"
```

`com.inventoryai.app/.MainActivity` means yes. `No activity found` means a standalone preview or
production build is installed; only then follow [Guide 2, Step 4](2-run-on-your-phone.md) to install a
development build. JavaScript changes never require a new build.

← [Guides index](README.md) · [Running and mirroring on a phone over USB](2-run-on-your-phone.md)
