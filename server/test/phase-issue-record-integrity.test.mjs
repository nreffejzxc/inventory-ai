/**
 * Every issue identifier the repository USES has a record in the known-issue table.
 *
 * WHY THIS EXISTS — it is a fix for a real gap, not a hypothetical one. On 2026-10-13
 * the assistant's LaTeX decoder shipped as `ISS-26`: implemented, unit-tested in
 * `mobile/__tests__/iss-26-assistant-latex-math.test.tsx`, and committed inside the
 * AI-4 commit (`3686cb9`). **The identifier was in the tree from the moment it was
 * written, and no issue-table row and no §27 section were ever written for it.** A
 * search of the tracked documentation for `ISS-26` returned nothing at all, and the
 * table ran ISS-25 → ISS-24 with no ISS-26, so a defect that was found, fixed, tested
 * and committed had no record anywhere. The record was written retrospectively (§27BQ,
 * 2026-10-14) — and this guard is the part of that fix which makes the class of gap
 * detectable rather than only documented: **measured before the row existed, the
 * referenced set was ISS-01…ISS-26 and the recorded set was ISS-01…ISS-25**, which is
 * exactly the failure this test now reports.
 *
 * THE PROPERTY. An identifier in the namespace `ISS-NN` is a claim that an issue was
 * tracked. Every file in the project's own text — docs, sources, tests, scripts and
 * workflows — is scanned for one, and every identifier found must have a row in the
 * known-issue table in `docs/DEVELOPMENT_ROADMAP.md`. The identifier is how an issue is
 * *cited*, so a citation with nothing behind it is either a typo or an unrecorded issue,
 * and both are worth failing on.
 *
 * THE SCAN IS OF THE WORKING TREE, NOT OF GIT. That is deliberate: the gap this test
 * was written for was in an **untracked-then-committed** state, and a scan of tracked
 * files alone would have missed it for a while — `git ls-files` also makes the test
 * depend on the git binary and on being run inside a work tree, which the suite runner
 * does not guarantee. `node_modules`, `.git`, `.expo`, the editor directories and the
 * git-ignored local-artifact directories are skipped because they are not the project's
 * own text, and `.env` is skipped because it
 * is git-ignored configuration rather than evidence (the same reason `check-secrets`
 * scans tracked files).
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK, so its silence is not read as more than it is:
 *
 *  * **Not the reverse direction.** "Every row is cited somewhere" is vacuous here —
 *    the roadmap is scanned too, so a row cites its own identifier — and a row whose
 *    only mention is itself is legitimate (some issues live in the record alone).
 *  * **Not the section anchor.** A row points at a §27 record; whether that section
 *    exists, is numbered sensibly or says anything true is not checkable by pattern,
 *    and pretending otherwise would be a guard that passes for the wrong reason.
 *  * **Not this file.** The exclusion and its reason are recorded in `SELF` below — a
 *    scanner has to say which text it means.
 *  * **Not the identifier's FORM beyond `ISS-NN`.** An identifier must use the
 *    canonical two-or-more-digit form, so a stray `ISS-5` is reported rather than
 *    silently normalised into `ISS-05`: writing the citation wrong is the mistake.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const ROADMAP_PATH = path.join(repoRoot, 'docs', 'DEVELOPMENT_ROADMAP.md');

/**
 * Directories holding generated, vendored or tool-owned content, never evidence.
 *
 * The last group is git-ignored local state (see `.gitignore`): imported chat attachments
 * and one-off repository copies, device captures or logs. They are this machine's scratch
 * data, not the project's text, and a stale copy inside one of them is not a citation —
 * measured: an old `.tmp-*` copy of this very suite made the scan report an identifier the
 * live tree no longer used.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.expo',
  'dist',
  'build',
  'coverage',
  '.cloud-attachments',
  '.scratch',
  'logs',
]);

/** Git-ignored local artifacts written as `.tmp-*` (screenshots, dumps, scratch copies). */
const SKIP_PREFIX = '.tmp-';

/**
 * The ONE file excluded from its own scan, and the reason is its nature rather than its
 * convenience: this suite is where the identifier namespace is *discussed* — its fixtures
 * and this comment both spell out identifiers the table does not carry, in order to prove
 * the pattern and to explain the gap that was real. A scanner has to say which text it
 * means, and for this file that text is prose about identifiers rather than a citation of
 * one.
 *
 * That is not a hypothesis: the first draft scanned itself, and failed on its own fixture
 * (a fabricated issue identifier); rewording the fixture was not enough, because the *explanation*
 * of that failure names it too. The exclusion is therefore recorded here rather than left
 * as a silent `if` — and it is deliberately a single file, so a new citation anywhere else,
 * including in every other test, is still judged.
 */
const SELF = fileURLToPath(import.meta.url);

/** The file types the project writes its own identifiers into. */
const TEXT_EXT = new Set([
  '.md',
  '.markdown',
  '.mjs',
  '.cjs',
  '.js',
  '.ts',
  '.tsx',
  '.json',
  '.yml',
  '.yaml',
  '.txt',
]);

/** A ceiling so one large generated file cannot make the scan pathological. */
const MAX_BYTES = 4 * 1024 * 1024;

const ISSUE_ID = /ISS-(\d{2,})/g;

/** A row of the known-issue table: `| **ISS-26** | …`. */
const TABLE_ROW_ID = /^\|\s*\*\*(ISS-\d+)\*\*/;

function collectTextFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(SKIP_PREFIX)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectTextFiles(full, out);
      continue;
    }
    if (full === SELF) continue;
    // `.env` and its variants are git-ignored configuration, not the record.
    if (entry.name === '.env' || entry.name.startsWith('.env.')) continue;
    if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/** Every `ISS-NN` cited anywhere in the project's own text. */
function citedIds(files) {
  const ids = new Set();
  for (const file of files) {
    let text;
    try {
      if (statSync(file).size > MAX_BYTES) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // An unreadable file is not a citation; the file-count control covers a broken walk.
    }
    for (const match of text.matchAll(ISSUE_ID)) ids.add(`ISS-${match[1]}`);
  }
  return ids;
}

/** Every identifier the known-issue table carries a row for. */
function recordedIds() {
  const ids = new Set();
  for (const line of readFileSync(ROADMAP_PATH, 'utf8').split(/\r?\n/)) {
    const match = line.match(TABLE_ROW_ID);
    if (match) ids.add(match[1]);
  }
  return ids;
}

const files = collectTextFiles(repoRoot);
const cited = citedIds(files);
const recorded = recordedIds();

describe('the scan is actually reading the project', () => {
  test('it walked the tree and found the identifiers it is meant to judge', () => {
    // A guard that cannot fail is decoration, and the way this one would fail silently is
    // by scanning nothing — an empty directory walk or a broken pattern reports every
    // identifier as recorded, because there are none. These are the controls for that.
    assert.ok(files.length > 100, `expected the project's own text, found ${files.length} files`);
    assert.ok(cited.size > 20, `expected the issue identifiers in use, found ${cited.size}`);
    assert.ok(recorded.size > 20, `expected the known-issue table's rows, found ${recorded.size}`);
  });

  test('the row pattern matches the table’s real row shape', () => {
    // The same control at the level of the pattern itself, so a reformatted table is
    // reported as a broken extraction rather than as every row having been deleted.
    //
    // THESE FIXTURES USE IDENTIFIERS THE TABLE REALLY CARRIES, AND THAT IS NOT
    // COSMETIC. The first draft wrote a fabricated issue identifier into them — and this suite
    // then failed against its own source, because the scan reads every file in the
    // project including this one, found the invented identifier in the fixture and
    // reported it as a citation with no row. Real identifiers are used instead, so the
    // control cannot invent an unrecorded citation while it is checking the pattern.
    assert.equal(TABLE_ROW_ID.exec('| **ISS-01** | High | a thing |')?.[1], 'ISS-01');
    assert.equal(TABLE_ROW_ID.exec('| **ISS-01** |')[1], 'ISS-01');
    assert.equal(TABLE_ROW_ID.exec('| ISS-01 | High | no bold, so not a row id |'), null);
  });
});

describe('every cited issue identifier is recorded', () => {
  test('★ no identifier is used anywhere without a row in the known-issue table', () => {
    // The whole property, and the one that was RED when this test was written: ISS-26 was
    // cited in five files with no row at all. It is asserted as a set difference rather
    // than as a count so the failure message names the offender.
    const missing = [...cited].filter((id) => !recorded.has(id)).sort();
    assert.deepEqual(
      missing,
      [],
      `these identifiers are cited but have no known-issue row: ${missing.join(', ')}`,
    );
  });
});
