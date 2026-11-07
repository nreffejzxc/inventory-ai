#!/usr/bin/env node
/**
 * Documentation map and invariant-register guard.
 *
 * WHY THIS EXISTS. The documentation set is large enough that a new page can
 * be added and never linked, while an old page keeps being edited because it
 * is the one people remember. The map in `docs/README.md` is the index, so the
 * index is checked mechanically. Separately, the auth checklist calls its
 * section 1 the single invariant register; a second register can appear in a
 * design discussion, or one row can be copied under two numbers during a
 * merge. Neither breaks a build. This guard makes both failures mechanical.
 *
 * WHAT IT CHECKS.
 *
 *  * Every Markdown page directly under `docs/` and every guide under
 *    `docs/guides/` is linked from `docs/README.md` (the map itself excepted).
 *  * Every Markdown target linked from the map exists.
 *  * Only `docs/AUTH_SECURITY_MASTER_CHECKLIST.md` declares invariant rows
 *    (`| I-N | ...`); references in prose remain valid.
 *  * No I-number is declared twice.
 *  * Every living reference document in the map's §2 table has one review-cadence
 *    row with a real last-reviewed date, and none is past its cadence.
 *
 * SCOPE. `docs/freebuff/` is excluded deliberately: it is a frozen audit
 * record, not an active authority. Its own README says it is not a security
 * policy, and its FB-007 task record carries a task-local unlink list numbered
 * I-1…I-8 for a feature that was later removed. The checklist is the only
 * active register this project maintains.
 *
 * This file is intentionally dependency-free and runs from the repository
 * root. It is invoked by the required `server` CI job before npm install, so a
 * documentation-only change is checked without a database or server install.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_ROOT = path.join(REPO_ROOT, 'docs');
const MAP_PATH = path.join(DOCS_ROOT, 'README.md');
const CHECKLIST_REL = 'docs/AUTH_SECURITY_MASTER_CHECKLIST.md';
const CHECKLIST_PATH = path.join(REPO_ROOT, CHECKLIST_REL);
const FROZEN_AUDIT_DIR = path.join(DOCS_ROOT, 'freebuff');

/** Directories that are generated, tool-owned or frozen provenance, not active docs. */
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

/** A table row that declares an invariant: `| I-1 | …` or `| **I-1** | …`. */
const DECLARATION = /^\|\s*\*{0,2}(I-\d+)\*{0,2}\s*\|/gm;

/** A Markdown link target, without an optional title. */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function relative(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function read(file) {
  return readFileSync(file, 'utf8');
}

/** Markdown files directly inside a directory, not recursive. */
function markdownIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.md')
    .map((entry) => path.join(dir, entry.name));
}

/** All active Markdown files under `docs/` root and `docs/guides/`. */
function activeDocFiles() {
  return [
    ...markdownIn(DOCS_ROOT),
    ...markdownIn(path.join(DOCS_ROOT, 'guides')),
  ].filter((file) => relative(file) !== 'docs/README.md');
}

/** Resolve every relative Markdown link in the map. */
function mapTargets(mapText) {
  const targets = new Set();
  for (const match of mapText.matchAll(LINK)) {
    let target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    target = target.replace(/[?#].*$/, '');
    if (!target) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      // Keep the literal target; the existence check below will report it.
    }
    targets.add(path.resolve(DOCS_ROOT, target));
  }
  return targets;
}

/** Every active Markdown file, excluding the frozen audit snapshot. */
function activeMarkdownFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.tmp-')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (full === FROZEN_AUDIT_DIR) continue;
      if (!SKIP_DIRS.has(entry.name)) activeMarkdownFiles(full, out);
      continue;
    }
    if (path.extname(entry.name).toLowerCase() !== '.md') continue;
    if (!statSync(full).isFile()) continue;
    out.push(full);
  }
  return out;
}

/** Every invariant declaration in a Markdown document, in file order. */
function declaredIds(text) {
  return [...text.matchAll(DECLARATION)].map((match) => match[1]);
}

/** Ids declared more than once, with their counts. */
function duplicates(ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1);
}

/** A review-cadence row: `| [document](path) | N days | YYYY-MM-DD |`. */
const CADENCE_ROW = /^\|\s*\[[^\]]*\]\(([^)]+)\)\s*\|\s*(\d+)\s*days?\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*$/;

/** Markdown documents linked from a set of map lines, resolved to absolute paths. */
function linkedDocuments(lines) {
  const documents = new Set();
  for (const line of lines) {
    for (const match of line.matchAll(LINK)) {
      let target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      target = target.replace(/[?#].*$/, '');
      if (!target || path.extname(target).toLowerCase() !== '.md') continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        // Keep the literal target; the map link check reports a missing file.
      }
      documents.add(path.resolve(DOCS_ROOT, target));
    }
  }
  return documents;
}

/** The map's living-reference documents and the cadence rows that schedule them. */
function reviewCadence(mapText) {
  const lines = mapText.split(/\r?\n/);
  const referenceStart = lines.findIndex((line) => line.startsWith('## 2. '));
  if (referenceStart === -1) return { error: 'docs/README.md has no §2 reference section' };
  let referenceEnd = lines.length;
  for (let i = referenceStart + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## 3. ')) {
      referenceEnd = i;
      break;
    }
  }
  const section = lines.slice(referenceStart + 1, referenceEnd);
  const cadenceStart = section.findIndex((line) => line.startsWith('### Review cadence'));
  if (cadenceStart === -1) {
    return { error: 'docs/README.md has no "### Review cadence" subsection' };
  }
  const documents = linkedDocuments(section.slice(0, cadenceStart));
  const rows = [];
  for (const line of section.slice(cadenceStart + 1)) {
    const match = line.match(CADENCE_ROW);
    if (!match) continue;
    let target = match[1].replace(/[?#].*$/, '');
    try {
      target = decodeURIComponent(target);
    } catch {
      // Keep the literal target; the row check below reports it.
    }
    rows.push({ file: path.resolve(DOCS_ROOT, target), days: Number(match[2]), date: match[3] });
  }
  return { documents, rows };
}

/** A calendar date as UTC milliseconds, or null when it is not one. */
function isoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

/** Overdue days for a review, or the reason the date cannot be judged. */
function reviewOverdue(date, days, today) {
  const reviewed = isoDate(date);
  if (reviewed === null) return { error: 'is not a real calendar date' };
  if (reviewed > today) return { error: 'is in the future' };
  const age = Math.floor((today - reviewed) / 86_400_000);
  return age > days ? { days: age - days } : {};
}

/** Prove the parser and duplicate check can fail before trusting a green run. */
function selfTest() {
  const planted = [
    '| I-1 | one |',
    '| **I-2** | two |',
    '| **I-2** | a duplicate |',
    'A prose reference to I-3 is not a register row.',
  ].join('\n');
  const ids = declaredIds(planted);
  if (ids.join(',') !== 'I-1,I-2,I-2') {
    throw new Error(`invariant parser control failed: ${JSON.stringify(ids)}`);
  }
  if (JSON.stringify(duplicates(ids)) !== JSON.stringify([['I-2', 2]])) {
    throw new Error('duplicate control failed');
  }
  if (declaredIds('A prose reference to I-19 only.').length !== 0) {
    throw new Error('prose reference control failed');
  }
  const targets = mapTargets('[a](guides/a.md) | [b](../README.md)');
  if (!targets.has(path.resolve(DOCS_ROOT, 'guides/a.md'))) {
    throw new Error('map link parser control failed');
  }
  const today = Date.parse('2026-11-07T00:00:00Z');
  if (reviewOverdue('2026-08-09', 90, today).days !== undefined) {
    throw new Error('review boundary control failed: exactly at cadence must pass');
  }
  if (reviewOverdue('2026-08-08', 90, today).days !== 1) {
    throw new Error('review overdue control failed');
  }
  if (!reviewOverdue('2026-11-08', 90, today).error) {
    throw new Error('future review date control failed');
  }
  if (!reviewOverdue('2026-02-30', 90, today).error) {
    throw new Error('impossible date control failed');
  }
  const plantedCadence = reviewCadence(
    '## 2. Reference\n| [a.md](a.md) | A |\n### Review cadence\n' +
      '| [a.md](a.md) | 90 days | 2026-01-01 |\n## 3. Records\n',
  );
  if (
    plantedCadence.error ||
    plantedCadence.rows.length !== 1 ||
    plantedCadence.documents.size !== 1
  ) {
    throw new Error('review cadence parser control failed');
  }
}

function main() {
  selfTest();

  const errors = [];
  if (!existsSync(MAP_PATH)) {
    errors.push('docs/README.md is missing');
  }
  if (!existsSync(CHECKLIST_PATH)) {
    errors.push(`${CHECKLIST_REL} is missing`);
  }
  if (errors.length > 0) {
    console.error('[docs] cannot run the guard:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  const mapText = read(MAP_PATH);
  const targets = mapTargets(mapText);
  const active = activeDocFiles();
  if (active.length < 20) {
    errors.push(`expected the active documentation set, found only ${active.length} pages`);
  }

  const unindexed = active.filter((file) => !targets.has(file));
  for (const file of unindexed) {
    errors.push(`active document is not linked from docs/README.md: ${relative(file)}`);
  }

  for (const target of targets) {
    if (path.extname(target).toLowerCase() !== '.md') continue;
    if (!existsSync(target)) {
      errors.push(`docs/README.md links a missing file: ${relative(target)}`);
    }
  }

  const files = activeMarkdownFiles(REPO_ROOT);
  const declarations = files.flatMap((file) => {
    return declaredIds(read(file)).map((id) => ({ file: relative(file), id }));
  });
  const checklistIds = declaredIds(read(CHECKLIST_PATH));
  if (checklistIds.length < 25) {
    errors.push(`expected the auth checklist register, found ${checklistIds.length} rows`);
  }
  if (!checklistIds.includes('I-1')) {
    errors.push('the auth checklist register does not start at I-1');
  }

  const outsideChecklist = declarations.filter(({ file }) => file !== CHECKLIST_REL);
  for (const { file, id } of outsideChecklist) {
    errors.push(`invariant ${id} is declared outside ${CHECKLIST_REL}: ${file}`);
  }
  for (const [id, count] of duplicates(declarations.map(({ id }) => id))) {
    errors.push(`invariant ${id} is declared ${count} times`);
  }

  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const cadence = reviewCadence(mapText);
  let cadenceRows = 0;
  if (cadence.error) {
    errors.push(cadence.error);
  } else {
    cadenceRows = cadence.rows.length;
    if (cadenceRows < 8) {
      errors.push(`expected the living reference set, found ${cadenceRows} review-cadence rows`);
    }
    const listed = new Set();
    for (const row of cadence.rows) {
      const file = relative(row.file);
      if (listed.has(row.file)) errors.push(`review cadence lists ${file} more than once`);
      listed.add(row.file);
      if (!cadence.documents.has(row.file)) {
        errors.push(`review cadence lists a document outside the §2 reference table: ${file}`);
      }
      if (!existsSync(row.file)) {
        errors.push(`review cadence points at a missing file: ${file}`);
      }
      if (!Number.isInteger(row.days) || row.days < 1 || row.days > 3650) {
        errors.push(`review cadence for ${file} has an unusable cadence: ${row.days} days`);
        continue;
      }
      const overdue = reviewOverdue(row.date, row.days, today);
      if (overdue.error) {
        errors.push(`review cadence for ${file}: last reviewed ${row.date} ${overdue.error}`);
      } else if (overdue.days) {
        errors.push(
          `living reference document is ${overdue.days} day(s) overdue for review: ${file} ` +
            `(last reviewed ${row.date}, cadence ${row.days} days)`,
        );
      }
    }
    for (const file of cadence.documents) {
      if (!listed.has(file)) {
        errors.push(`living reference document has no review-cadence row: ${relative(file)}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error('[docs] failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `[docs] ${active.length} active documents indexed; ` +
      `${declarations.length} invariant rows, checklist-only; ` +
      `${checklistIds.length} register rows; ` +
      `${cadenceRows} living reference documents within review cadence.`,
  );
}

main();
