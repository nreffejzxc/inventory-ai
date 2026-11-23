/**
 * Pure decisions for `scripts/device/install.mjs`.
 *
 * The install helper exists because a bare `adb install` once selected the
 * physical production phone and replaced its app with a debug APK. Everything
 * here is deliberately free of adb and the filesystem so every refusal can be
 * tested without a phone.
 */

export const APP_PACKAGE = 'com.inventoryai.app';

export class InstallArgumentError extends Error {}

export function parseInstallArgs(argv = [], env = process.env) {
  const options = {
    serial: '',
    apk: '',
    adbPath: env.ADB_PATH || 'adb',
    aaptPath: env.AAPT_PATH || '',
    aaptExplicit: Boolean(env.AAPT_PATH),
    apply: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--help' || raw === '-h') options.help = true;
    else if (raw === '--apply') options.apply = true;
    else if (raw === '--check') options.apply = false;
    else if (raw === '--serial' || raw === '--apk' || raw === '--adb' || raw === '--aapt') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new InstallArgumentError(`${raw} needs a value`);
      }
      if (raw === '--serial') options.serial = value;
      else if (raw === '--apk') options.apk = value;
      else if (raw === '--adb') options.adbPath = value;
      else {
        options.aaptPath = value;
        options.aaptExplicit = true;
      }
      index += 1;
    } else if (raw.startsWith('--serial=')) {
      options.serial = raw.slice('--serial='.length);
    } else if (raw.startsWith('--apk=')) {
      options.apk = raw.slice('--apk='.length);
    } else if (raw.startsWith('--adb=')) {
      options.adbPath = raw.slice('--adb='.length);
    } else if (raw.startsWith('--aapt=')) {
      options.aaptPath = raw.slice('--aapt='.length);
      options.aaptExplicit = true;
    } else {
      throw new InstallArgumentError(`unknown argument: ${raw}`);
    }
  }
  if (!options.help && !options.serial) {
    throw new InstallArgumentError(
      'an explicit --serial=<device> is required; automatic device selection is refused',
    );
  }
  if (!options.help && !options.apk) {
    throw new InstallArgumentError('--apk=<file.apk> is required');
  }
  return options;
}

/** `adb devices -l` output, without trusting an implicit single-device choice. */
export function parseDevices(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state, line };
    })
    .filter((device) => device.serial && device.state);
}

/**
 * Require the exact serial the operator named. There is intentionally no
 * fallback to "the only attached device": that is the failure this helper
 * exists to remove.
 */
export function selectExplicitSerial(serial, devices) {
  const requested = String(serial ?? '').trim();
  if (!requested) {
    throw new InstallArgumentError(
      'an explicit --serial=<device> is required; automatic device selection is refused',
    );
  }
  const matches = devices.filter((device) => device.serial === requested);
  if (matches.length === 0) {
    const visible = devices.map((device) => `${device.serial} (${device.state})`).join(', ');
    throw new InstallArgumentError(
      `serial "${requested}" is not attached${visible ? `; saw ${visible}` : ''}`,
    );
  }
  const device = matches[0];
  if (device.state !== 'device') {
    throw new InstallArgumentError(
      `serial "${requested}" is ${device.state}, not "device"; authorize/unlock it before installing`,
    );
  }
  return device.serial;
}

/** Read the facts aapt reports for the APK being installed. */
export function parseBadging(output) {
  const text = String(output ?? '');
  const pkg = /^package:\s+name='([^']+)'(?:\s+versionCode='([^']+)')?(?:\s+versionName='([^']+)')?/m.exec(text);
  if (!pkg) return null;
  const versionCode = pkg[2] === undefined ? null : Number(pkg[2]);
  return {
    packageName: pkg[1],
    versionCode: Number.isInteger(versionCode) && versionCode > 0 ? versionCode : null,
    versionName: pkg[3] ?? null,
    debug: /^application-debuggable\s*$/m.test(text),
  };
}

/**
 * Read the installed package's version and debuggable flag. `debug: null` is
 * "unknown", not "production"; the decision below refuses unknown rather than
 * guessing.
 */
export function parseInstalledPackage(output) {
  const text = String(output ?? '');
  const version = /(?:^|\s)versionCode=(\d+)/m.exec(text);
  const hasFlags = /(?:^|\n)\s*(?:pkgFlags|flags)=\[/.test(text);
  if (!version || !hasFlags) {
    return { versionCode: null, debug: null };
  }
  return {
    versionCode: Number(version[1]),
    debug: /\bDEBUGGABLE\b/.test(text),
  };
}

/** The one adb invocation that changes the device. */
export function installArgs(serial, apk) {
  return ['-s', serial, 'install', '-r', apk];
}

/**
 * Decide whether this APK may touch this installed package. A refusal has a
 * reason suitable for an operator; an unknown installed state is a refusal.
 */
export function decideInstall({ apk, installed }) {
  if (!apk || apk.packageName !== APP_PACKAGE) {
    return {
      allowed: false,
      reason: `APK package is ${apk?.packageName ?? 'unknown'}, expected ${APP_PACKAGE}`,
    };
  }
  if (!Number.isInteger(apk.versionCode) || apk.versionCode < 1) {
    return {
      allowed: false,
      reason: 'APK versionCode could not be read; refusing to install an unidentified build',
    };
  }
  if (!installed || installed.installed === false) {
    return { allowed: true, reason: 'package is not installed on this device' };
  }
  if (installed.versionCode === null || installed.debug === null) {
    return {
      allowed: false,
      reason: 'the installed package state could not be read; refusing to replace it',
    };
  }
  if (apk.debug && installed.debug === false) {
    return {
      allowed: false,
      reason: 'refusing to replace the non-debuggable production app with a debuggable APK',
    };
  }
  if (apk.versionCode < installed.versionCode) {
    return {
      allowed: false,
      reason: `APK versionCode ${apk.versionCode} is older than installed ${installed.versionCode}`,
    };
  }
  return {
    allowed: true,
    reason: installed.debug ? 'replacing an existing debuggable build' : 'replacing a release build',
  };
}
