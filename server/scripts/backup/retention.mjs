// Which encrypted archives to keep — 14 daily, 4 weekly, 3 monthly.
//
// WHY THIS IS A SEPARATE, PURE MODULE. Retention deletes the only copy of a
// recovery point, so the decision has to be provable without a database, a
// clock or a filesystem: `planRetention` takes archive names and returns
// keep/remove lists. The caller does the deleting. That also means the policy
// can be checked against a synthetic year of names (see the verification in
// docs/BACKUP_ENCRYPTED_RUNBOOK.md) instead of being trusted.
//
// THE BUCKETS UNION, THEY DO NOT SLICE. Each rule independently names the newest
// archive in each of its periods — 14 most recent days, 4 most recent ISO weeks,
// 3 most recent calendar months — and the keep set is their union. A bucket
// therefore never deletes an archive another bucket protects, which is the
// failure that matters here (a weekly copy removed because the daily window had
// moved past it).
//
// THREE THINGS ARE ALWAYS KEPT: the newest archive (even if it fell outside
// every bucket, e.g. a clock jump), anything the caller explicitly protects
// (the archive this run just created), and any name this module cannot parse —
// an unrecognised file is not evidence that it is safe to delete.

/** Defaults match SECURITY_CHANGE_2026-11-27.md §7. */
export const RETENTION_DEFAULTS = Object.freeze({ daily: 14, weekly: 4, monthly: 3 });

/** `inventoryai_prod_db-20261127T054513Z.tar.gz.gpg` */
const ARCHIVE_NAME = /^(.+)-(\d{8}T\d{6}Z)\.tar\.gz\.gpg$/;

/**
 * Parse an encrypted archive name into its database and UTC timestamp.
 * Returns null for anything that is not exactly this shape — including the
 * `.sha256` sidecar, which travels with its archive rather than being a copy.
 */
export function parseArchiveName(name) {
  const match = ARCHIVE_NAME.exec(String(name ?? ''));
  if (!match) return null;
  const stamp = match[2];
  const iso =
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` +
    `T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  if (at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') !== stamp) return null;
  return { name: match[1] + '-' + stamp + '.tar.gz.gpg', database: match[1], stamp, at };
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

/** ISO-8601 week (`2026-W48`), computed on the UTC calendar. */
function weekKey(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function positiveCount(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`retention ${label} must be a positive integer, got ${value}`);
  }
  return value;
}

/**
 * @param {string[]} names archive file names in ONE directory (sidecars are ignored)
 * @param {{daily?: number, weekly?: number, monthly?: number, protect?: string[]}} [options]
 * @returns {{keep: string[], remove: string[], buckets: {daily: string[], weekly: string[], monthly: string[]}, unknown: string[]}}
 */
export function planRetention(names, options = {}) {
  const counts = {
    daily: positiveCount(options.daily ?? RETENTION_DEFAULTS.daily, 'daily'),
    weekly: positiveCount(options.weekly ?? RETENTION_DEFAULTS.weekly, 'weekly'),
    monthly: positiveCount(options.monthly ?? RETENTION_DEFAULTS.monthly, 'monthly'),
  };

  const parsed = [];
  const unknown = [];
  for (const name of names ?? []) {
    const entry = parseArchiveName(name);
    if (entry) parsed.push(entry);
    else unknown.push(String(name));
  }

  // Newest first. The timestamp is inside the name, so this does not depend on
  // mtime, which a copy or a sync client rewrites.
  parsed.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.name < b.name ? 1 : -1));

  const buckets = { daily: [], weekly: [], monthly: [] };
  const rules = [
    ['daily', counts.daily, dayKey],
    ['weekly', counts.weekly, weekKey],
    ['monthly', counts.monthly, monthKey],
  ];
  for (const [bucket, limit, keyOf] of rules) {
    const seen = new Set();
    for (const entry of parsed) {
      const key = keyOf(entry.at);
      if (seen.has(key)) continue;
      if (buckets[bucket].length >= limit) break;
      seen.add(key);
      buckets[bucket].push(entry.name);
    }
  }

  const protectedNames = new Set(options.protect ?? []);
  const keep = new Set([...Object.values(buckets).flat(), ...protectedNames]);
  if (parsed.length > 0) keep.add(parsed[0].name);

  const keepList = parsed.filter((entry) => keep.has(entry.name)).map((entry) => entry.name);
  const remove = parsed.filter((entry) => !keep.has(entry.name)).map((entry) => entry.name);
  // Caller-protected names that are not in this directory are kept by the caller,
  // not reported here; the list above is only what exists on disk.
  return { keep: keepList, remove, buckets, unknown };
}
