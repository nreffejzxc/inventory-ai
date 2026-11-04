/**
 * Docs section integrity — a plan record may not claim a number twice, and a citation may not point at nothing.
 *
 * WHY THIS EXISTS — it is written from a defect that happened, twice over, in one afternoon.
 *
 * 1. **A number was claimed twice.** The server-bumps record was written as **§27CB** on its own branch,
 *    from the stated assumption that §27BC–§27CA would land with the AI campaign and that §27CB was free on
 *    both trees. It was not: the AI campaign also carried a **§27CB** (the Markdown word-boundary guard),
 *    so the two records collided the moment both existed in one tree. Nothing failed — no test, no build —
 *    and the collision was found by a human reading a conflict. Resolving it cost a renumbering across three
 *    documents and a rewrite of the section's own justification.
 * 2. **A citation pointed at a section that does not exist.** `docs/PHASE_HISTORY.md` sent readers to a
 *    "27A onward" section. There is no 27A: the lettered series starts at 27B, and the plan-record series
 *    begins at §27. That citation had been live and wrong for an unknown length of time, and was found only
 *    because the scanner below was run against the whole tree. (The identifier is written here **without its
 *    sigil** on purpose: this file is scanned by its own rule — there is no self-exclusion — so quoting a bad
 *    citation verbatim would recreate the defect.)
 *
 * Neither is a typo in the ordinary sense. Both are the same failure: **the document numbering is an index,
 * and nothing checked it.** This project guards its route inventory, its issue identifiers, its module graph
 * and its dependency pins the same way — this is the missing one.
 *
 * WHAT IT MEASURES. Two properties, over the project's own text (docs, sources, tests, scripts, workflows —
 * the same corpus rule the issue-record guard uses):
 *
 *  * **No plan record is numbered twice** in `docs/DEVELOPMENT_ROADMAP.md`.
 *  * **Every `§27…` citation resolves** to a plan record in that file. A citation is how a record is
 *    *referenced*, so a citation with nothing behind it is either a typo or a record that was renumbered
 *    without its callers — and both are worth failing on.
 *
 * SCOPING IS MEASURED, NOT CHOSEN FOR CONVENIENCE. The roadmap's **plan** records are the `27…` namespace.
 * Small integers are a *different* convention: records use `## 1. …`, `## 4. …` as local sub-headings, and
 * **four such numbers repeat today** (`1`, `2`, `3`, `4`, each used three times across different records).
 * A guard over "every numbered heading" would therefore report four false positives on a clean tree and be
 * deleted within a week. The namespace is what is checked, and this paragraph is why.
 *
 * WHAT IT IS NOT, so its green is not read as more than it is:
 *
 *  * **It cannot see a collision before the two records meet.** Two branches can each claim §27CB and both be
 *    clean; this fires when the second one lands — at the merge, which is exactly the moment the defect
 *    becomes real, and earlier than the human who found it by hand.
 *  * **It does not check whether a record says anything true**, whether its number is *sensible*, or whether
 *    §27CA is the section the sentence meant. It checks that the number exists and is unique.
 *  * **It says nothing about numbering outside the `27…` namespace** — the small-integer convention above,
 *    or `§14C.9`-style references into the design authority, which is a different document with its own
 *    numbering and is deliberately not constrained by this file.
 *  * **The scanners are exercised by an in-test control** (below) as well as over the real tree, because a
 *    guard whose scan silently matched nothing would pass forever. The real-tree proof — a duplicate and a
 *    dangling citation injected into the corpus, watched failing, tree restored byte-identically — is what
 *    the roadmap record cites.
 *
 * A THIRD PROPERTY JOINED LATER (2026-10-15, §27CG): **every declared record is reachable from `CLAUDE.md`.**
 * The file is this project's entry point — an increment lands a paragraph there and its record here — and that
 * convention had lagged invisibly: measured mechanically, **29 of the roadmap's 82 plan records had no `§`
 * anchor anywhere in `CLAUDE.md`**, so a reader (or an agent) starting from the instruction file could not find
 * them at all. Nothing failed, because nothing checked. The rule is the same shape as the two above and is
 * enforced the same way, with one honest limit stated here rather than discovered: it is **mechanical** — it
 * looks for the anchor, not for the subject — so a record described under another heading without being named
 * still counts as a violation, and the remedy is one line rather than an argument.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const ROADMAP_PATH = path.join(repoRoot, 'docs', 'DEVELOPMENT_ROADMAP.md');

/** Directories holding generated, vendored or tool-owned content, never evidence. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.expo',
  'dist',
  'build',
  'coverage',
  // Imported chat attachments are agent-owned working data, not project text.
  '.cloud-attachments',
]);

/** The file types the project writes its own text into. */
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

/** The plan-record namespace, as used in the roadmap's headings. */
const PLAN_RECORD = /^#{1,3}\s+(27[A-Z]{1,3})\.\s+\S/m;

/** How a record is cited, anywhere in the project's text. */
const CITATION = /§\s?(27[A-Z]{1,3})\b/g;

/** Every plan-record id declared in a document, in order. */
function planRecordIds(text) {
  return [...text.matchAll(new RegExp(PLAN_RECORD.source, 'gm'))].map((m) => m[1]);
}

/** Ids declared more than once, each with how many times it is claimed. */
function duplicateRecordIds(ids) {
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1);
}

/** Citations in a document that name no declared record. */
function danglingCitations(text, known) {
  const out = [];
  for (const m of text.matchAll(CITATION)) if (!known.has(m[1])) out.push(m[1]);
  return out;
}

/** Every file in the project's own text, as paths relative to the repository root. */
function projectTextFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      // `.env` and friends are git-ignored configuration rather than evidence, and are never read.
      if (entry.name.startsWith('.env')) continue;
      if (!TEXT_EXT.has(path.extname(entry.name))) continue;
      if (!statSync(full).isFile()) continue;
      out.push(path.relative(repoRoot, full));
    }
  };
  walk(repoRoot);
  return out;
}

const CLAUDE_PATH = path.join(repoRoot, 'CLAUDE.md');

/**
 * The declared records that cannot be found in the instruction file.
 *
 * A record is *reachable* when its anchor appears anywhere in `CLAUDE.md` — as a citation
 * (`roadmap §27CF`) or in the index block that lists the ones this file does not carry by
 * name. The anchor is the test, not the subject: see the header for why that limit is stated
 * rather than papered over with a smarter matcher nobody could check.
 */
function recordsUnreachableFrom(ids, claudeText) {
  return ids.filter((id) => !claudeText.includes(id));
}

const roadmap = readFileSync(ROADMAP_PATH, 'utf8');
const claude = readFileSync(CLAUDE_PATH, 'utf8');
const declared = planRecordIds(roadmap);
const declaredSet = new Set(declared);

describe('docs section integrity', () => {
  test('the scan is actually reading the project', () => {
    // A guard whose walk returns nothing, or whose parser matches nothing, passes forever. Both are
    // asserted to be doing work before their silence is trusted, and both floors come from a measurement
    // rather than a guess: the tree held **79** plan records and **446** text files when this was written.
    assert.ok(declared.length > 70, `expected >70 plan records, found ${declared.length}`);
    const files = projectTextFiles();
    assert.ok(files.length > 400, `expected >400 text files, found ${files.length}`);
    // The control corpus is not the guard's opinion: one known record and one known citation must be
    // visible to the same helpers the assertions below use.
    assert.ok(declaredSet.has('27CB'), 'sanity: §27CB is a declared record');
    assert.ok(declaredSet.has('27CC'), 'sanity: §27CC is a declared record');
    assert.deepEqual(danglingCitations('see §27CB', declaredSet), []);
  });

  test('★ no plan record claims a number another record already claimed', () => {
    assert.deepEqual(duplicateRecordIds(declared), []);
  });

  test('★ every §27 citation resolves to a declared record', () => {
    const violations = [];
    for (const file of projectTextFiles()) {
      const text = readFileSync(path.join(repoRoot, file), 'utf8');
      for (const id of danglingCitations(text, declaredSet)) violations.push(`${file}: §${id}`);
    }
    assert.deepEqual(violations, []);
  });

  test('★ every declared plan record is reachable from CLAUDE.md', () => {
    // The entry point is only an entry point if the records are visible from it. The floor in the case
    // above proves the walk is reading the project; this proves the file it reads is the real one.
    assert.ok(claude.length > 20_000, `CLAUDE.md looks too small to be the instruction file (${claude.length})`);
    assert.ok(claude.includes('Documentation index'), 'sanity: the index block is where the pointers live');
    assert.deepEqual(recordsUnreachableFrom(declared, claude), []);
  });

  test('the scanners can fail — an in-test control for both properties', () => {
    // The control proves the *helpers* report what the assertions above would catch. It is not a
    // substitute for the real-tree break/restore proof, which the roadmap record cites.
    // The unresolvable identifier is assembled from parts rather than written out, so this file contains no
    // literal citation to a section that does not exist and needs no self-exclusion — the corpus stays whole.
    const DANGLING = '§' + '27' + 'ZZ';
    const plant = [
      '# 27CB. The first record (2026-01-01)',
      '',
      'Body.',
      '',
      '# 27CB. A second record claiming the same number (2026-01-02)',
      '',
      `See §27CB and ${DANGLING}.`,
    ].join('\n');
    const ids = planRecordIds(plant);
    assert.deepEqual(ids, ['27CB', '27CB'], 'the planted duplicate must be seen');
    assert.deepEqual(duplicateRecordIds(ids), [['27CB', 2]]);
    const known = new Set(ids);
    assert.deepEqual(danglingCitations(plant, known), ['27ZZ'], 'the planted dangling citation must be seen');
    // And the negative direction: a citation that does resolve is not reported.
    assert.deepEqual(danglingCitations('§27CB', new Set(['27CB'])), []);

    // The reachability scanner, controlled the same way: a record absent from the file is reported, one
    // present is not. Both directions, so a function that returned [] for everything cannot pass here.
    assert.deepEqual(recordsUnreachableFrom(['27CB', '27CZ'], 'this file mentions 27CB only'), ['27CZ']);
    assert.deepEqual(recordsUnreachableFrom(['27CB'], 'this file mentions 27CB only'), []);
  });
});
