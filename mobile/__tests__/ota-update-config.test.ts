/**
 * Over-the-air updates — the two things that, if they silently changed, would deliver the
 * wrong JavaScript to the wrong binary.
 *
 * WHY THIS GUARD EXISTS. Adding `expo-updates` turns two config values into a delivery
 * contract that no type, lint rule or screen test can see:
 *
 *   1. **`runtimeVersion` is the compatibility label.** An update is served only to builds
 *      whose runtime version matches it EXACTLY. Under the `appVersion` policy that label
 *      is derived from `expo.version`, so a JavaScript-only change ships over the air and a
 *      native change ships with a version bump (and therefore a new label). If this ever
 *      reverted to a hand-typed literal, the literal could drift from the version that is
 *      actually installed, and an OTA update could reach a binary it was never built
 *      against — the failure would be a crash on launch, after the bad update had already
 *      been installed.
 *
 *      WHY NOT `fingerprint` (measured 2026-10-24, build `71d63d16`). The fingerprint policy
 *      was tried first because it derives the label automatically. It cannot work with this
 *      project's dynamic config: `app.config.js` resolves `android.googleServicesFile` and
 *      `ios.googleServicesFile` from EAS *file* environment variables, whose paths (and the
 *      files they name) exist only on the build runner. EAS computed
 *      `6217b878d4238c37f68b848c2649d2a2c617181f` on the runner and the CLI computed
 *      `e32953a7894593a4e41d1ca76592f3df00d5eeae` on the laptop — the build aborted in the
 *      Configure expo-updates phase with "Runtime version calculated on local machine not
 *      equal to runtime version calculated during build", before compiling anything. The
 *      documented fingerprint sources it reported were `expoConfigExternalFile` and
 *      `bareNativeDir`. `appVersion` removes that class of mismatch entirely, at the cost of
 *      one manual rule: a change that alters native code must bump `expo.version`.
 *
 *   2. **`channel` decides which branch a build listens to.** The channel is baked into the
 *      binary at build time and cannot be changed in an installed app. Two profiles that
 *      accidentally share a channel means publishing a preview update would silently reach
 *      production installs (or the reverse), and nothing in the app would look wrong.
 *
 * The assertions are deliberately about the CONFIG FILES, because that is where both
 * decisions live. They do not prove delivery: `docs/evidence/device-runs/` records the run
 * where a published update was received by an installed APK.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
type EasJson = { build?: Record<string, { channel?: string; extends?: string }> };

const projectRoot = join(__dirname, '..');
const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(join(projectRoot, name), 'utf8')) as T;

const packageJson = readJson<Manifest>('package.json');
const appJson = readJson<{ expo: Record<string, any> }>('app.json');
const easJson = readJson<EasJson>('eas.json');

const expo = appJson.expo;
const projectId = expo.extra?.eas?.projectId as string | undefined;
const profiles = easJson.build ?? {};

/** The channel a profile ends up with: its own, or the one it extends. */
function resolveChannel(name: string): string | undefined {
  const profile = profiles[name];
  if (!profile) return undefined;
  if (profile.channel) return profile.channel;
  return profile.extends ? resolveChannel(profile.extends) : undefined;
}

describe('the OTA runtime contract', () => {
  it('installs expo-updates, without which an installed APK cannot receive an update', () => {
    expect(packageJson.dependencies?.['expo-updates']).toBeDefined();
  });

  it('derives the runtime version from the app version, not from a hand-typed string', () => {
    // A literal would be free to disagree with the installed build; a policy cannot.
    expect(expo.runtimeVersion).toEqual({ policy: 'appVersion' });
    expect(typeof expo.version).toBe('string');
    expect(expo.version.length).toBeGreaterThan(0);
  });

  it('points updates at THIS project, so an update cannot be published into another one', () => {
    expect(projectId).toBeTruthy();
    expect(expo.updates?.url).toBe(`https://u.expo.dev/${projectId}`);
  });

  it('never makes a launch wait on the network for an update', () => {
    // ON_LOAD checks once per launch; a zero fallback means the launch proceeds with what
    // is already on the device and a download finishes in the background. A non-zero value
    // would put the update host on the path of every cold start.
    expect(expo.updates?.checkAutomatically).toBe('ON_LOAD');
    expect(expo.updates?.fallbackToCacheTimeout).toBe(0);
  });
});

describe('every build listens to exactly one channel', () => {
  const names = Object.keys(profiles);

  it('finds the five profiles it is meant to guard (positive control)', () => {
    expect(names.sort()).toEqual([
      'development',
      'ios-simulator',
      'preview',
      'production',
      'production-apk',
    ]);
  });

  it('gives every profile a channel, inherited where the profile extends another', () => {
    for (const name of names) {
      expect([name, resolveChannel(name)]).toEqual([name, expect.any(String)]);
    }
  });

  it('cannot be made blind: a profile with no channel and no parent resolves to nothing', () => {
    // The comparator's own negative control. If `resolveChannel` started returning a
    // default, a profile that forgot its channel would pass the case above while shipping
    // an install that listens to nothing — or, worse, to `default`.
    const orphan = (build: EasJson['build']) => {
      const saved = easJson.build;
      easJson.build = build;
      try {
        return resolveChannel('forgotten');
      } finally {
        easJson.build = saved;
      }
    };
    expect(orphan({ forgotten: {} })).toBeUndefined();
    expect(orphan({ forgotten: { extends: 'missing' } })).toBeUndefined();
  });

  it('keeps preview and production on different channels', () => {
    expect(resolveChannel('preview')).toBe('preview');
    expect(resolveChannel('production')).toBe('production');
    expect(resolveChannel('preview')).not.toBe(resolveChannel('production'));
  });

  it('packages the production release as an APK on the same channel, deliberately', () => {
    // Same release, different container: an APK for the phone and an AAB for Play. They must
    // receive the same OTA updates, so the shared channel is the contract, not a collision.
    expect(resolveChannel('production-apk')).toBe('production');
  });

  it('keeps the development client on its own channel too', () => {
    expect(resolveChannel('development')).toBe('development');
    expect(resolveChannel('ios-simulator')).toBe('development');
  });

  it('has no two profiles sharing a channel by accident', () => {
    const byChannel = new Map<string, string[]>();
    for (const name of names) {
      const channel = resolveChannel(name)!;
      byChannel.set(channel, [...(byChannel.get(channel) ?? []), name]);
    }
    // development and ios-simulator deliberately share `development` (the simulator
    // profile extends the device one); nothing else may share.
    expect(Object.fromEntries(byChannel)).toEqual({
      development: ['development', 'ios-simulator'],
      preview: ['preview'],
      production: ['production', 'production-apk'],
    });
  });
});
