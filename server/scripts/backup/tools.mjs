// External-tool prerequisites for the encrypted backup wrapper.
//
// `gpg` and `tar` do the work: they are the only two programs the wrapper runs.
// `gpgconf` and `gpg-connect-agent` are the GnuPG 2.x tools the documented verify
// workflow and the test suite need — to kill/launch the agent and to preset a
// passphrase through stdin (which also requires `allow-preset-passphrase` in
// gpg-agent.conf). Checking all four before a run is deliberately stricter than
// the wrapper's own minimum: a missing agent tool becomes one clear refusal
// instead of a later, misleading failure while verifying an archive.
import { BackupSafetyError } from './lib.mjs';

export const REQUIRED_TOOLS = Object.freeze([
  {
    command: 'gpg',
    args: ['--version'],
    label: 'gpg',
    hint: 'Install GnuPG 2.x and ensure "gpg" is on PATH.',
  },
  {
    command: 'tar',
    args: ['--version'],
    label: 'tar',
    hint: 'Install tar and ensure "tar" is on PATH.',
  },
  {
    command: 'gpgconf',
    args: ['--version'],
    label: 'gpgconf',
    hint:
      'gpgconf ships with GnuPG 2.x; install it and ensure "gpgconf" is on PATH. ' +
      'It clears and launches gpg-agent during verification.',
  },
  {
    command: 'gpg-connect-agent',
    args: ['--version'],
    label: 'gpg-connect-agent',
    hint:
      'gpg-connect-agent ships with GnuPG 2.x; install it and ensure ' +
      '"gpg-connect-agent" is on PATH. It presets a passphrase through stdin for ' +
      'non-interactive verification.',
  },
]);

/**
 * Run each required command's harmless version check.
 *
 * `run` is injected so the failure messages can be tested without manipulating
 * PATH or hiding a real tool. It must reject when the command cannot be run or
 * exits non-zero.
 */
export async function assertTools(run) {
  if (typeof run !== 'function') {
    throw new TypeError('assertTools requires a run(command, args) function');
  }
  for (const tool of REQUIRED_TOOLS) {
    try {
      await run(tool.command, tool.args);
    } catch (error) {
      const detail =
        error instanceof Error && error.message ? ` Details: ${error.message.slice(0, 500)}` : '';
      throw new BackupSafetyError(
        `Missing prerequisite: ${tool.label} could not be run ` +
          `(${tool.command} ${tool.args.join(' ')}). ${tool.hint}${detail}`,
      );
    }
  }
}
