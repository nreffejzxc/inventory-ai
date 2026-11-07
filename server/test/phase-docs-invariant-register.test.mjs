/**
 * The auth checklist is the only invariant register, and every I-number is unique.
 *
 * WHY THIS EXISTS. The checklist calls §1 "the single invariant register"; the
 * architecture's §11 points to it and says a new or changed invariant is recorded
 * there, not duplicated in the architecture. That division is a convention, and
 * conventions drift: a second table can be added during a design discussion, or
 * one row can be copied under two numbers during a merge. Neither breaks a build.
 * This guard makes both failures mechanical.
 *
 * WHAT IT MEASURES.
 *
 *  * Only `docs/AUTH_SECURITY_MASTER_CHECKLIST.md` may declare an invariant row.
 *    A declaration is a Markdown table row whose first cell is `I-N`, with or
 *    without bold. References in prose (for example the architecture's `I-19`)
 *    are not declarations and remain valid.
 *  * No I-number may be declared twice, whether inside the checklist or across
 *    the active documentation set.
 *
 * SCOPE. `docs/freebuff/` is excluded deliberately. It is a frozen audit record,
 * not an active authority: its own README says it is "not ... a security policy"
 * and that every current-state statement in it is a September 2026 snapshot.
 * Its FB-007 task record carries a task-local unlink list numbered `I-1…I-8` for
 * a feature that was later removed. Treating that archive as a live register
 * would either fail forever or force a rewrite of provenance; the checklist is
 * the only active register this project maintains.
 *
 * WHAT IT DOES NOT CHECK. It does not require every prose reference to resolve
 * (historical records may cite retired or renamed ideas), does not require the
 * I-numbers to be contiguous, and does not read list-style or heading-style
 * declarations. The current register is a table; a new shape would need a parser
 * change, which is what this file records rather than guesses at.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const CHECKLIST_REL = 'docs/AUTH_SECURITY_MASTER_CHECKLIST.md';
const CHECKLIST_PATH = path.join(repoRoot, CHECKLIST_REL);
const FROZEN_AUDIT_DIR = path.join(repoRoot, 'docs', 'freebuff');

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

/** Every active Markdown file, excluding the frozen audit snapshot. */
function activeMarkdownFiles(dir, out = []) {
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

const files = activeMarkdownFiles(repoRoot);
const declarations = files.flatMap((file) => {
  const rel = path.relative(repoRoot, file).split(path.sep).join('/');
  return declaredIds(readFileSync(file, 'utf8')).map((id) => ({ file: rel, id }));
});
const checklistIds = declaredIds(readFileSync(CHECKLIST_PATH, 'utf8'));
const outsideChecklist = declarations.filter(({ file }) => file !== CHECKLIST_REL);

describe('docs invariant register', () => {
  test('the scan is reading the checklist and the active documentation set', () => {
    assert.ok(existsSync(CHECKLIST_PATH), `${CHECKLIST_REL} must exist`);
    assert.ok(files.length > 20, `expected active Markdown files, found ${files.length}`);
    assert.ok(checklistIds.length >= 25, `expected the checklist register, found ${checklistIds.length} rows`);
    assert.ok(checklistIds.includes('I-1'), 'sanity: the checklist register starts at I-1');
  });

  test('★ the checklist is the only active invariant register', () => {
    assert.deepEqual(
      outsideChecklist.map(({ file, id }) => `${file}: ${id}`),
      [],
      'an invariant row was declared outside the auth checklist',
    );
  });

  test('★ no I-number is declared twice', () => {
    assert.deepEqual(
      duplicates(declarations.map(({ id }) => id)),
      [],
      'an I-number is declared more than once',
    );
    assert.deepEqual(duplicates(checklistIds), [], 'the checklist register repeats an I-number');
  });

  test('the declaration parser and duplicate check can fail', () => {
    const planted = [
      '| I-1 | one |',
      '| **I-2** | two |',
      '| **I-2** | a duplicate |',
      'A prose reference to I-3 is not a register row.',
    ].join('\n');

    assert.deepEqual(declaredIds(planted), ['I-1', 'I-2', 'I-2']);
    assert.deepEqual(duplicates(declaredIds(planted)), [['I-2', 2]]);
    assert.deepEqual(declaredIds('A prose reference to I-19 only.'), []);
    assert.deepEqual(duplicates(['I-1', 'I-2']), []);
  });
});
