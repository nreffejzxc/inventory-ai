# Draft PO force-stop and same-key resume — 2026-11-23

**Scope.** Local, disposable test data only. No production server, database, credential, deployment
or production configuration was used. The one physical-device side effect and its recovery are
recorded under **Device-safety incident** below.

## Automated rerun with the production identity

### Build

The Android project was regenerated from this tree and rebuilt with the production package ID and
version:

```text
npx expo prebuild --platform android --clean --no-install
package: com.inventoryai.app
versionName: 1.0.2
versionCode: 1
```

`aapt dump badging` on both artifacts reports `package: name='com.inventoryai.app'
versionCode='1' versionName='1.0.2'`. The debug build is debug-signed; it is not a Play artifact.

| ABI | Artifact | Size | SHA-256 | Build |
| --- | --- | --- | --- | --- |
| `x86_64` (emulator proof) | `mobile/build/standalone/app-debug-inventoryai-1.0.2-x86_64.apk` | 94 MB | `c508119f4a87efcf782b362264b3fed00a35b6df802b23fc92dc8439b1d29714` | 589 tasks, **1m 20s** (incremental after the first x86 build) |
| `arm64-v8a` (phone ABI) | `mobile/build/standalone/app-debug-inventoryai-1.0.2-arm64-v8a.apk` | 94 MB | `f8eca7763a722446951b3ae294f54ed8f8a243d20852207c67046019348bfacb` | 589 tasks, **5m 07s** |

The generated Android project is not built in place: its object paths exceed Windows' path limit.
The build ran from the repository's known short-path copy at `C:\iab`, with the generated
`app/build.gradle` carrying `arguments "-DCMAKE_OBJECT_PATH_MAX=250"`. This is a local build
workaround, not a source change. The generated project in `mobile/android` still has the long-path
limitation unless the same argument is applied.

The debug build was installed with an explicit serial on the Android 15 emulator:

```text
adb -s emulator-5554 install -r app-debug.apk
pkg=com.inventoryai.app  versionCode=1  versionName=1.0.2  ABI x86_64
```

### Environment

- **Device:** Android emulator `sdk_gphone64_x86_64` (`emulator-5554`), Android 15 / API 35.
- **JavaScript:** Metro on `8081` from this tree; local Firebase public variables were empty so the
  disposable test account used the documented email/password path.
- **API path:** emulator → `adb reverse tcp:4001` → logging proxy on `127.0.0.1:4001` →
  `127.0.0.1:4000` (`NODE_ENV=test`, database `inventoryai_test_db`).
- **Account:** disposable `draftproof-1795403412084@example.com`; supplier, location and two products
  are the `Draft Proof … 1795403412084` fixture rows.

### Automation

`scripts/device/run.mjs --journey=draft-resume` drives the native UI through the form, submits,
proves the process is gone, cold-starts the bundle, reopens the route, resumes, and invokes
`server/scripts/verify-draft-po-resume.mjs`.

The logging proxy records the complete request line before forwarding. It force-stops the app only
**once per operation key**, after the request is fully received and before it is forwarded; the
resumed request carries the same key and is forwarded normally.

Final command (paths shortened only where shown):

```text
node scripts/device/run.mjs --journey=draft-resume --allow-writes \
  --serial=emulator-5554 \
  --supplier="Draft Proof Supplier 1795403412084" \
  --location="Draft Proof Bay 1795403412084" \
  --product1="Draft Proof Gadget 1795403412084" \
  --product2="Draft Proof Widget 1795403412084" \
  --proxy-log="…/automated-2026-11-23T06-38Z/proxy.jsonl" \
  --database=inventoryai_test_db \
  --out="…/automated-2026-11-23T06-38Z/journey3"
```

Result: **20/20 steps passed, exit 0**, in
[`automated-2026-11-23T06-38Z/journey3/report.json`](automated-2026-11-23T06-38Z/journey3/report.json).
The report includes the force-stop proof, the restored-attempt notice, the resumed order screen
([`draft-po-resumed.png`](automated-2026-11-23T06-38Z/journey3/draft-po-resumed.png)), and the
one-DRAFT database verification. `node scripts/device/run.mjs --self-test` passes **6 journeys /
142 steps**.

### Request evidence

The first request, its force-stop, and its forwarded response:

```json
{"ts":"2026-11-23T06:46:05.257Z","event":"request","method":"POST","url":"/api/purchase-orders/from-restock","key":"op-mwswjpgd-qxpii9119ib5in6h","body":{"supplierId":"6b03ae9518155bb28ee03ed2","locationId":"6b03ae9518155bb28ee03ed4","items":[{"productId":"6b03ae9618155bb28ee03ed8","availableQuantity":0,"minimumStock":3},{"productId":"6b03ae9518155bb28ee03ed6","availableQuantity":0,"minimumStock":5}]}}
{"ts":"2026-11-23T06:46:05.257Z","event":"force-stop-before-forward","package":"com.inventoryai.app","key":"op-mwswjpgd-qxpii9119ib5in6h"}
{"ts":"2026-11-23T06:46:06.660Z","event":"response","method":"POST","url":"/api/purchase-orders/from-restock","key":"op-mwswjpgd-qxpii9119ib5in6h","status":201}
```

The resumed request, **same key and the same 251-byte body**, forwarded without a second kill:

```json
{"ts":"2026-11-23T06:47:15.512Z","event":"request","method":"POST","url":"/api/purchase-orders/from-restock","key":"op-mwswjpgd-qxpii9119ib5in6h","body":{"supplierId":"6b03ae9518155bb28ee03ed2","locationId":"6b03ae9518155bb28ee03ed4","items":[{"productId":"6b03ae9618155bb28ee03ed8","availableQuantity":0,"minimumStock":3},{"productId":"6b03ae9518155bb28ee03ed6","availableQuantity":0,"minimumStock":5}]}}
{"ts":"2026-11-23T06:47:15.513Z","event":"force-stop-skipped","package":"com.inventoryai.app","key":"op-mwswjpgd-qxpii9119ib5in6h","reason":"repeat-key"}
{"ts":"2026-11-23T06:47:15.817Z","event":"response","method":"POST","url":"/api/purchase-orders/from-restock","key":"op-mwswjpgd-qxpii9119ib5in6h","status":201}
```

### Database evidence

The read-only verifier queried `inventoryai_test_db` by tenant, key and captured supplier/location/
product ids:

```json
{
  "detail": "exactly one DRAFT (PO-0005) for op-mwswjpgd-qxpii9119ib5in6h",
  "count": 1,
  "po": {
    "id": "6b03e12e3e8eee646356cac7",
    "number": "PO-0005",
    "status": "DRAFT",
    "requestKey": "op-mwswjpgd-qxpii9119ib5in6h",
    "requestFingerprint": "a1cf27b08424dbe41aee967c1dc18e0f9b5df4c572692fd9f00a4bd5f0227476",
    "createdAt": "2026-11-23T06:46:06.273Z",
    "items": [
      {"productName": "Draft Proof Gadget 1795403412084", "quantityOrdered": 3},
      {"productName": "Draft Proof Widget 1795403412084", "quantityOrdered": 5}
    ]
  }
}
```

**Result:** exactly one DRAFT, `PO-0005`, for the captured key and body. The replay created no
second order and no second line. Earlier local attempts (`PO-0003`, `PO-0004`) remain in the
disposable test database; `PO-0004` was separately verified as exactly one DRAFT for its key, and the
final `PO-0005` above was verified after the automated run.

### Harness fixes found by the rerun

Three failures were in the **automation**, not the app, and are fixed and recorded:

1. The success screen says `Purchase Order` / `PO-0005`, not `Draft PO-`. The old assertion was
   corrected after the app had already created the order.
2. `Resume draft creation` and the submit button sit below the fold; the journey now scrolls before
   asserting them. The old swipe started in the emulator's gesture-navigation area and sent the app
   to Home; the harness now uses a mid-screen swipe.
3. A cold start can deliver the first route intent before the navigator mounts; the relaunch step
   now retries the deep link until the form renders, instead of reporting a blind pass.

The proxy's earlier behavior killed **every** matching request, which would have killed the resumed
submit too. It now kills one attempt per key and logs `force-stop-skipped` on the replay.

## Earlier manual proof (same day, before the identity rebuild)

The first run used the then-generated project, which still declared `com.inventoryai` / `1.0`. It
selected the same fixture, submitted key `op-mwsquuwv-w7fgh5se445ud204`, and was force-stopped at
`2026-11-23T04:06:48Z` before the response. A cold reopen restored both rows; **Resume draft
creation** sent the same key/body at `04:09:00.827Z`, and the database held one DRAFT, `PO-0001`
(3 × Gadget, 5 × Widget). That result remains valid for the replay behavior, but its app identity
is superseded by the rebuilt `com.inventoryai.app` / `1.0.2` above.

## Device-safety incident

While installing the rebuilt APK, one command omitted `-s`. The emulator had shut down, so
`adb install` selected the attached physical phone (`PV4DDMIZZLTCIVSK`, CPH1969). The scripted
uninstall removed the existing production install and the debug APK was installed in its place.
**The phone's local app data and session were lost. No server database, production data or
configuration was changed.**

The prior local production APK was recovered from
`%TEMP%\inventoryai-prod.apk` (`com.inventoryai.app`, versionCode **10**, versionName **1.0.2**,
valid v2 signature, universal ABI) and reinstalled on the phone after removing the debug build.
The phone now has the production binary again; the owner must sign in again because Android
removed the app's local data during uninstall. Every later command used an explicit
`-s emulator-5554` or `-s PV4DDMIZZLTCIVSK`.

## Limitations

- The automated proof is **emulator evidence**, not a physical-phone lifecycle proof. The rebuild
  and install on the phone were not used for the journey; its local data had been cleared and the
  production binary was restored instead.
- The debug APK is `versionCode 1`, debug-signed, and cannot be installed over the production
  `versionCode 10` install. It must not be used as a production upgrade path.
- The build needs the short-path copy and `CMAKE_OBJECT_PATH_MAX=250` on Windows. The generated
  project in `mobile/android` is not patched.
- Firebase public configuration was empty only for this local login path; the server and replay
  logic under test were unchanged.
- The proof defines success for this key/body and this tenant. It does not prove a physical-device
  process kill under Android's own low-memory killer, nor a server crash after commit; the latter is
  covered by the real-DB service test.
