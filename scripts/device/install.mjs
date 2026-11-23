#!/usr/bin/env node
/**
 * Serial-guarded Android install.
 *
 *   node scripts/device/install.mjs --serial=<serial> --apk=<path> [--check|--apply]
 *
 * Read-only by default. `--apply` is required to call `adb install`. The helper
 * refuses automatic device selection, requires one exact attached serial,
 * verifies the APK package and version, and refuses a debuggable APK when the
 * installed app is non-debuggable. It never uninstalls, clears data or picks a
 * production build for you.
 *
 * EXIT CODES
 *   0  check passed, or install succeeded
 *   1  refused or install failed
 *   2  NOT CHECKED (arguments, adb/aapt unavailable, device/package state unreadable)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { adb, DeviceUnavailable } from './adb.mjs';
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
} from './install-lib.mjs';

const USAGE = `Serial-guarded Inventory AI Android install.

Usage:
  node scripts/device/install.mjs --serial=<device> --apk=<file.apk> [options]

Required:
  --serial=<device>   exact adb serial; automatic selection is refused
  --apk=<file.apk>    APK to inspect

Options:
  --check             inspect only (default)
  --apply             install after every check passes
  --adb=<path>        adb executable (default: adb)
  --aapt=<path>       aapt executable used to read the APK (default: Android SDK build-tools, then PATH)
  --help              this text

A debuggable APK is refused when ${APP_PACKAGE} is installed and not debuggable.
The helper never uninstalls or clears app data. Run --check first.

EXIT CODES
  0  safe/installed
  1  refused or install failed
  2  not checked
`;

class NotChecked extends Error {}
class Refused extends Error {}

/** Use the Android SDK's build-tools aapt when the operator did not name one. */
function resolveAaptPath(configured) {
  if (configured) return configured;
  const root = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (root) {
    const directory = join(root, 'build-tools');
    try {
      const versions = readdirSync(directory).sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      );
      const name = process.platform === 'win32' ? 'aapt.exe' : 'aapt';
      for (const version of versions) {
        const candidate = join(directory, version, name);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Fall through to PATH; inspectApk reports a missing aapt as NOT CHECKED.
    }
  }
  return process.platform === 'win32' ? 'aapt.exe' : 'aapt';
}

function inspectApk(aaptPath, apkPath) {
  if (!existsSync(apkPath)) throw new NotChecked(`APK does not exist: ${apkPath}`);
  if (!statSync(apkPath).isFile()) throw new NotChecked(`APK is not a file: ${apkPath}`);
  let output;
  try {
    output = execFileSync(aaptPath, ['dump', 'badging', apkPath], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new NotChecked(
        `aapt was not found (${aaptPath}); set --aapt= or AAPT_PATH to an Android build-tools aapt`,
      );
    }
    throw new NotChecked(`aapt could not inspect ${apkPath}: ${err?.message ?? err}`);
  }
  const facts = parseBadging(output);
  if (!facts) throw new NotChecked('aapt did not report an APK package');
  return facts;
}

function inspectInstalled(serial, adbPath) {
  let listing;
  try {
    listing = adb(['-s', serial, 'shell', 'pm', 'list', 'packages', APP_PACKAGE], { adbPath });
  } catch (err) {
    throw new NotChecked(`could not list installed packages on ${serial}: ${err?.message ?? err}`);
  }
  if (!listing.split(/\r?\n/).some((line) => line.trim() === `package:${APP_PACKAGE}`)) {
    return { installed: false };
  }

  let dump;
  try {
    dump = adb(['-s', serial, 'shell', 'dumpsys', 'package', APP_PACKAGE], { adbPath });
  } catch (err) {
    throw new NotChecked(`could not read installed package state on ${serial}: ${err?.message ?? err}`);
  }
  return { installed: true, ...parseInstalledPackage(dump) };
}

function printFacts({ serial, apk, installed, decision, apply }) {
  console.log(`[install] mode=${apply ? 'apply' : 'check'} serial=${serial}`);
  console.log(
    `[install] apk=${apk.packageName} versionCode=${apk.versionCode ?? 'unknown'} ` +
      `debug=${apk.debug ? 'yes' : 'no'}`,
  );
  if (installed.installed === false) {
    console.log('[install] installed=no');
  } else {
    console.log(
      `[install] installed=${APP_PACKAGE} versionCode=${installed.versionCode ?? 'unknown'} ` +
        `debug=${installed.debug === null ? 'unknown' : installed.debug ? 'yes' : 'no'}`,
    );
  }
  console.log(`[install] ${decision.allowed ? 'ALLOW' : 'REFUSE'}: ${decision.reason}`);
}

async function main() {
  let args;
  try {
    args = parseInstallArgs(process.argv.slice(2));
  } catch (err) {
    throw new NotChecked(err instanceof InstallArgumentError ? err.message : String(err));
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const apk = inspectApk(resolveAaptPath(args.aaptPath), args.apk);

  let devices;
  try {
    devices = parseDevices(adb(['devices', '-l'], { adbPath: args.adbPath }));
  } catch (err) {
    throw new NotChecked(
      err instanceof DeviceUnavailable
        ? err.message
        : `could not list adb devices: ${err?.message ?? err}`,
    );
  }
  const serial = selectExplicitSerial(args.serial, devices);
  const installed = inspectInstalled(serial, args.adbPath);
  const decision = decideInstall({ apk, installed });
  printFacts({ serial, apk, installed, decision, apply: args.apply });
  if (!decision.allowed) throw new Refused(decision.reason);
  if (!args.apply) {
    console.log('[install] check passed; nothing was installed. Re-run with --apply to install.');
    return 0;
  }

  let output;
  try {
    output = adb(installArgs(serial, args.apk), { adbPath: args.adbPath, timeout: 120_000 });
  } catch (err) {
    throw new Refused(`adb install failed: ${err?.message ?? err}`);
  }
  if (output.trim()) console.log(output.trim());
  console.log(`[install] installed on ${serial}; app data was not cleared.`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof Refused) {
      console.error(`[install] REFUSED (exit 1) — ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(
      `[install] NOT CHECKED (exit 2) — ${err instanceof NotChecked ? err.message : err?.message ?? err}`,
    );
    process.exitCode = 2;
  });
