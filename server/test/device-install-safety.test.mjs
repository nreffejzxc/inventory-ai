import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  APP_PACKAGE,
  InstallArgumentError,
  decideInstall,
  installArgs,
  parseBadging,
  parseDevices,
  parseInstallArgs,
  parseInstalledPackage,
  selectExplicitSerial,
} from '../../scripts/device/install-lib.mjs';

/**
 * The install helper must never infer a device. These tests cover the pure
 * decisions; no adb, aapt or phone is needed.
 */

const BADGING_DEBUG = `package: name='${APP_PACKAGE}' versionCode='1' versionName='1.0.2' compileSdkVersion='36' platformBuildVersionName='16'
sdkVersion:'24'
targetSdkVersion:'36'
application-label:'Inventory AI'
application-debuggable
launchable-activity: name='com.inventoryai.app.MainActivity'  label='' icon=''
`;

const BADGING_RELEASE = `package: name='${APP_PACKAGE}' versionCode='10' versionName='1.0.2' compileSdkVersion='36'
sdkVersion:'24'
targetSdkVersion:'36'
application-label:'Inventory AI'
launchable-activity: name='com.inventoryai.app.MainActivity'  label='' icon=''
`;

test('install arguments require both an explicit serial and an APK', () => {
  assert.throws(
    () => parseInstallArgs(['--apk=app-debug.apk']),
    (err) => err instanceof InstallArgumentError && /explicit --serial/.test(err.message),
  );
  assert.throws(
    () => parseInstallArgs(['--serial=emulator-5554']),
    (err) => err instanceof InstallArgumentError && /--apk/.test(err.message),
  );
  const parsed = parseInstallArgs([
    '--serial=emulator-5554',
    '--apk',
    'C:\\builds\\app-debug.apk',
    '--aapt=C:\\Android\\aapt.exe',
  ]);
  assert.equal(parsed.serial, 'emulator-5554');
  assert.equal(parsed.apk, 'C:\\builds\\app-debug.apk');
  assert.equal(parsed.aaptPath, 'C:\\Android\\aapt.exe');
  assert.equal(parsed.apply, false, 'inspection is the default; --apply is explicit');
});

test('install arguments accept value flags and expose unknown arguments', () => {
  const parsed = parseInstallArgs([
    '--serial',
    'PV4DDMIZZLTCIVSK',
    '--apk',
    'app-release.apk',
    '--apply',
  ]);
  assert.equal(parsed.serial, 'PV4DDMIZZLTCIVSK');
  assert.equal(parsed.apk, 'app-release.apk');
  assert.equal(parsed.apply, true);
  assert.throws(() => parseInstallArgs(['--serial=x', '--apk=y', '--force']), /unknown argument/);
});

test('device selection is exact and never falls back to the only attached phone', () => {
  const devices = parseDevices(`List of devices attached
PV4DDMIZZLTCIVSK       device product:CPH1969 model:CPH1969 device:OP4A
emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64
`);
  assert.deepEqual(
    devices.map((d) => [d.serial, d.state]),
    [
      ['PV4DDMIZZLTCIVSK', 'device'],
      ['emulator-5554', 'device'],
    ],
  );
  assert.equal(selectExplicitSerial('emulator-5554', devices), 'emulator-5554');
  assert.throws(() => selectExplicitSerial('', devices), /automatic device selection is refused/);
  assert.throws(() => selectExplicitSerial('not-attached', devices), /not attached/);
  assert.throws(
    () => selectExplicitSerial('PV4DDMIZZLTCIVSK', parseDevices('List of devices attached\nPV4DDMIZZLTCIVSK unauthorized\n')),
    /unauthorized/,
  );
});

test('badging reads package, version and the debuggable flag', () => {
  assert.deepEqual(parseBadging(BADGING_DEBUG), {
    packageName: APP_PACKAGE,
    versionCode: 1,
    versionName: '1.0.2',
    debug: true,
  });
  assert.deepEqual(parseBadging(BADGING_RELEASE), {
    packageName: APP_PACKAGE,
    versionCode: 10,
    versionName: '1.0.2',
    debug: false,
  });
  assert.equal(parseBadging('not an APK'), null);
});

test('installed package state is unknown unless version and flags are both readable', () => {
  assert.deepEqual(
    parseInstalledPackage(`Packages:
  Package [${APP_PACKAGE}] (4a1b):
    versionCode=10 minSdk=24 targetSdk=36
    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]
    pkgFlags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]
`),
    { versionCode: 10, debug: false },
  );
  assert.deepEqual(
    parseInstalledPackage(`Package [${APP_PACKAGE}]:
  versionCode=1
  flags=[ DEBUGGABLE HAS_CODE ]
`),
    { versionCode: 1, debug: true },
  );
  assert.deepEqual(parseInstalledPackage('Unable to find package'), {
    versionCode: null,
    debug: null,
  });
});

test('a debuggable APK is refused over the production app', () => {
  const decision = decideInstall({
    apk: parseBadging(BADGING_DEBUG),
    installed: { installed: true, versionCode: 10, debug: false },
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /refusing to replace the non-debuggable production app/);
});

test('a release APK may replace the production app; a dev build may replace a dev build', () => {
  assert.equal(
    decideInstall({
      apk: parseBadging(BADGING_RELEASE),
      installed: { installed: true, versionCode: 10, debug: false },
    }).allowed,
    true,
  );
  assert.equal(
    decideInstall({
      apk: parseBadging(BADGING_DEBUG),
      installed: { installed: true, versionCode: 1, debug: true },
    }).allowed,
    true,
  );
  assert.equal(
    decideInstall({
      apk: parseBadging(BADGING_DEBUG),
      installed: { installed: false },
    }).allowed,
    true,
  );
});

test('unknown installed state, wrong package and downgrade are refused', () => {
  assert.equal(
    decideInstall({
      apk: parseBadging(BADGING_DEBUG),
      installed: { installed: true, versionCode: null, debug: null },
    }).allowed,
    false,
  );
  assert.equal(
    decideInstall({
      apk: parseBadging(BADGING_DEBUG),
      installed: { installed: true, versionCode: 1, debug: false },
    }).allowed,
    false,
  );
  assert.equal(
    decideInstall({
      apk: { ...parseBadging(BADGING_RELEASE), packageName: 'com.example.other' },
      installed: { installed: false },
    }).allowed,
    false,
  );
  assert.equal(
    decideInstall({
      apk: { ...parseBadging(BADGING_RELEASE), versionCode: 9 },
      installed: { installed: true, versionCode: 10, debug: false },
    }).allowed,
    false,
  );
});

test('every mutating adb call is built with -s and the explicit serial', () => {
  assert.deepEqual(installArgs('emulator-5554', 'app-debug.apk'), [
    '-s',
    'emulator-5554',
    'install',
    '-r',
    'app-debug.apk',
  ]);
});

test('the CLI uses the guarded command and cannot auto-select a device', () => {
  const source = readFileSync(new URL('../../scripts/device/install.mjs', import.meta.url), 'utf8');
  assert.match(source, /adb\(installArgs\(serial, args\.apk\)/);
  assert.doesNotMatch(source, /\bdeviceInfo\b/);
  assert.match(source, /--apply/);
  assert.match(source, /--serial=<device>/);
});
