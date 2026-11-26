// External-tool prerequisites for the encrypted backup wrapper.
//
// `gpg` and `tar` are the only programs the wrapper runs, so they are the only
// programs it requires. The wrapper refuses to start without them instead of
// failing later, halfway through an archive it would have to discard.
//
// `gpgconf` and `gpg-connect-agent` are NOT on that list. They ship with GnuPG
// 2.x and are used by the documented verification workflow and by the test
// suites — to clear the agent cache and to preset a passphrase over stdin — but
// the wrapper itself never invokes either. Requiring them at runtime refused a
// perfectly usable backup host that had `gpg` and `tar`. A caller that needs
// them asks for `AGENT_TOOLS` explicitly.
import { BackupSafetyError } from './lib.mjs';

const GPG = {
  command: 'gpg',
  args: ['--version'],
  label: 'gpg',
  hint:
    'Install GnuPG and ensure "gpg" is on PATH. The wrapper encrypts the archive with it, ' +
    'and decryption of a protected key needs the GnuPG 2.x agent.',
};

const TAR = {
  command: 'tar',
  args: ['--version'],
  label: 'tar',
  hint: 'Install tar and ensure "tar" is on PATH. The wrapper builds the archive with it.',
};

const GPGCONF = {
  command: 'gpgconf',
  args: ['--version'],
  label: 'gpgconf',
  hint:
    'gpgconf ships with GnuPG 2.x; install it and ensure "gpgconf" is on PATH. ' +
    'It clears and launches gpg-agent during verification.',
};

const GPG_CONNECT_AGENT = {
  command: 'gpg-connect-agent',
  args: ['--version'],
  label: 'gpg-connect-agent',
  hint:
    'gpg-connect-agent ships with GnuPG 2.x; install it and ensure ' +
    '"gpg-connect-agent" is on PATH. It presets a passphrase through stdin for ' +
    'non-interactive verification.',
};

/** What the wrapper needs: the two programs it runs. */
export const REQUIRED_TOOLS = Object.freeze([GPG, TAR]);

/** What the verification workflow and the suites need on top of that. */
export const AGENT_TOOLS = Object.freeze([GPGCONF, GPG_CONNECT_AGENT]);

/**
 * Run each tool's harmless version check.
 *
 * `run` is injected so the failure messages can be tested without manipulating
 * PATH or hiding a real tool. It must reject when the command cannot be run or
 * exits non-zero. `tools` defaults to what the wrapper runs; pass `AGENT_TOOLS`
 * to also prove the GnuPG 2.x agent tools.
 */
export async function assertTools(run, tools = REQUIRED_TOOLS) {
  if (typeof run !== 'function') {
    throw new TypeError('assertTools requires a run(command, args) function');
  }
  for (const tool of tools) {
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
