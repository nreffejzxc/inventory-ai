// Archive member validation for the encrypted backup wrapper.
//
// `--verify` treats an archive as external input. Before tar extracts anything,
// two listings are checked:
//
//   * `tar -tvzf` supplies the member type; only regular files and directories
//     are accepted. A symlink could point outside the extraction directory even
//     when its own name is harmless, and device/FIFO/socket members are never
//     produced by `backup:db`.
//   * `tar -tzf` supplies the member names; absolute paths, Windows drive
//     prefixes, backslashes, `..` segments, NUL bytes and multiple top-level
//     roots are refused.
//
// Keeping this as a pure function makes the hostile-member rules testable
// without a database, a real archive, or a privileged filesystem. The wrapper
// still performs the two tar listings and passes their output here.
import path from 'node:path';

import { BackupSafetyError } from './lib.mjs';

const UNSAFE_MEMBER_TYPE =
  'Refusing to extract: the archive contains a link or special file; only regular files and directories are allowed.';
const UNSAFE_PATH =
  'Refusing to extract: the archive contains an unsafe path';
const UNSAFE_ROOT =
  'Refusing to extract: the archive must contain exactly one safe top-level directory.';
const EMPTY_ARCHIVE = 'Refusing to extract: the archive is empty.';

/**
 * Validate tar's verbose and plain listings.
 *
 * `details` is `tar -tvzf` output; its first character is the member type.
 * `entries` is `tar -tzf` output, one member name per line. Returns the single
 * safe top-level directory name.
 */
export function validateArchiveListing(details, entries) {
  const detailLines = String(details ?? '')
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of detailLines) {
    if (line[0] !== '-' && line[0] !== 'd') {
      throw new BackupSafetyError(UNSAFE_MEMBER_TYPE);
    }
  }

  const names = String(entries ?? '')
    .split(/\r?\n/)
    .filter(Boolean);
  if (names.length === 0) throw new BackupSafetyError(EMPTY_ARCHIVE);

  for (const entry of names) {
    // Split both separators so a Windows-style `root\..\outside` member is
    // rejected on every host, not only where `path.isAbsolute` understands it.
    const parts = entry.split(/[\\/]+/).filter(Boolean);
    if (
      path.isAbsolute(entry) ||
      /^[A-Za-z]:/.test(entry) ||
      entry.includes('\\') ||
      entry === '.' ||
      parts.includes('..') ||
      entry.includes('\0')
    ) {
      throw new BackupSafetyError(`${UNSAFE_PATH} "${entry}".`);
    }
  }

  const roots = new Set(names.map((entry) => entry.split('/')[0]));
  if (roots.size !== 1 || [...roots][0] === '.' || [...roots][0] === '..') {
    throw new BackupSafetyError(UNSAFE_ROOT);
  }
  return [...roots][0];
}
