/**
 * §27AX — documentation-drift guard for the route inventory.
 *
 * WHY THIS EXISTS. `docs/superpowers/specs/2026-09-18-firebase-auth-design.md` §2.6 states how many
 * routes the application mounts and how they split across the Phase 23 buckets. That sentence is
 * prose: it cannot fail a build, so it drifted. On 2026-10-12 it said **68** routes when the mounted
 * set was **72** — AUTH-03 (`POST /api/auth/renew`), AUTH-04 (`POST /api/auth/email-verification/request`
 * and `/confirm`) and the N-4 credential-change bridge (`POST /api/auth/credentials-changed`) had all
 * shipped without the figure being re-read. Nothing detected it for ten days, because no test read a
 * document.
 *
 * WHAT IT MEASURES, AND WHY TWO INDEPENDENT METHODS AGREE. This file never imports the application.
 * It classifies the **declarations** in `server/src/routes/*.ts` plus the routes registered directly
 * on the app in `server/src/app.ts`. The Phase 23 guard classifies the **same set** from the mounted
 * router stacks at runtime (`router.stack`). Two different layers, two different techniques, one
 * number (85 on 2026-10-25): 50 permission-gated + 14 authenticated + 21 public + 0 role-gated. If the two ever
 * disagree, one of them is wrong and this file says so rather than quietly passing.
 *
 * WHAT IT IS NOT. It asserts nothing about authorization. The classification is deliberately a
 * *source-text* one — `requireAuth(`, `requirePermission(`, `requireRole(` in the declaration — and
 * the phase 23/24 guards remain the authority for what those gates actually do at runtime. This file
 * exists to keep a documented number honest, and nothing more.
 *
 * FAIL LOUDLY ON REFORMATTING, NOT SILENTLY. If §2.6's sentence is reworded so the figures can no
 * longer be read, the parser returns `null` and the first case fails with the sentence it wanted.
 * A guard that shrugged at an unparseable document would be decoration; the alternative — a loose
 * regex that matched a reworded sentence and compared the wrong numbers — would be worse.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(testDir, '..', '..');
const ROUTES_DIR = path.join(REPO_ROOT, 'server', 'src', 'routes');
const APP_FILE = path.join(REPO_ROOT, 'server', 'src', 'app.ts');
const DESIGN_DOC = path.join(
  REPO_ROOT,
  'docs',
  'superpowers',
  'specs',
  '2026-09-18-firebase-auth-design.md'
);

/** The four buckets, in the order the documented sentence names them. */
const BUCKETS = ['gated', 'authenticated', 'public', 'roleGated'];

/**
 * The exact §2.6 sentence shape, matched against whitespace-normalised text.
 *
 * The figures are bolded and the sentence wraps across two source lines, so the text is normalised
 * before matching. Every figure this guard compares is a capture group; nothing is hardcoded here,
 * which is the difference between "the document agrees with the code" and "the document agrees with
 * a number someone typed into a test".
 */
const INVENTORY_PATTERN =
  /classifies \*\*(\d+) routes\*\*: \*\*(\d+) permission-gated\*\*, \*\*(\d+) authenticated\*\*, \*\*(\d+) public\*\*, \*\*(\d+) role-gated\*\*/;

/**
 * Read the documented inventory, or `null` when the sentence cannot be read.
 *
 * `null` is a deliberate signal, not an error class: the caller asserts on it, so a rewording
 * produces a readable failure naming the sentence this parser expects.
 */
function parseDocumentedInventory(raw) {
  const normalised = String(raw).replace(/\s+/g, ' ');
  const match = normalised.match(INVENTORY_PATTERN);
  if (!match) return null;
  return {
    total: Number(match[1]),
    gated: Number(match[2]),
    authenticated: Number(match[3]),
    public: Number(match[4]),
    roleGated: Number(match[5]),
  };
}

/**
 * Remove comments before scanning for declarations.
 *
 * Block comments first, then whole-line `//` comments. Trailing `// …` after a declaration is left
 * alone on purpose: the declaration slice stops at its terminating `;`, so anything after it cannot
 * affect the classification, and a naive `//` strip would corrupt a string literal containing `://`.
 */
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every `router.<verb>(` / `app.<verb>(` declaration in a source file, sliced to its `;`. */
function declarationsIn(source) {
  const text = stripComments(source).replace(/\s+/g, ' ');
  const declarations = [];
  const opener = /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(/g;
  let match;
  while ((match = opener.exec(text)) !== null) {
    const end = text.indexOf(';', match.index);
    assert.notEqual(
      end,
      -1,
      `a ${match[1].toUpperCase()} declaration starting at offset ${match.index} has no terminating ';' — this scanner cannot classify it`
    );
    declarations.push(text.slice(match.index, end));
  }
  return declarations;
}

/**
 * Classify one declaration from its own text.
 *
 * Order matters and mirrors the Phase 23 classifier: a role-name gate is checked before a permission
 * gate, because a route carrying `requireRole` is role-gated by owner decision and must never be
 * counted as permission-gated. `requireAuth` present with neither gate is AUTHENTICATED — the bucket
 * that exists precisely for a route gated by nothing but the caller's own identity.
 */
function classifyDeclaration(declaration) {
  // These are matched as NAMES, not as calls. A route registration passes a middleware by
  // REFERENCE — `router.get('/:id', requireAuth, c.get)` — so requiring a trailing `(` here matched
  // nothing and classified all 72 routes as public. `requirePermission` IS invoked
  // (`requirePermission(PERMISSIONS.X)`), but it is matched by name all the same, so one rule covers
  // every gate and there is no second form to keep in step.
  // AUTH-03 fix (2026-10-22): `/renew` authenticates with `requireAuthForRenewal`, a
  // variant that relaxes ONLY token expiry so the client can replace the token it was
  // just refused. It is authentication, not a public route — a tier count is a statement
  // about who may call a route, not about which middleware spelling was used.
  if (!/\brequireAuth\b|\brequireAuthForRenewal\b|\brequirePlatformAdmin\b/.test(declaration)) {
    return 'public';
  }
  if (/\brequireRole\b/.test(declaration)) return 'roleGated';
  // PLAT-1: the platform plane's gate is a capability from its own catalogue,
  // not `requirePermission` (which consults the tenant role matrix).
  if (/\brequirePermission\b|\brequirePlatformCapability\b/.test(declaration)) return 'gated';
  return 'authenticated';
}

/** Measure the real inventory from the router sources plus the app-level registrations. */
function measureInventory() {
  const files = [
    ...fs
      .readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => path.join(ROUTES_DIR, f)),
    APP_FILE,
  ];

  const counts = { gated: 0, authenticated: 0, public: 0, roleGated: 0 };
  const byFile = {};

  for (const file of files) {
    const declarations = declarationsIn(fs.readFileSync(file, 'utf8'));
    const local = { gated: 0, authenticated: 0, public: 0, roleGated: 0 };
    for (const declaration of declarations) {
      const bucket = classifyDeclaration(declaration);
      counts[bucket] += 1;
      local[bucket] += 1;
    }
    byFile[path.basename(file)] = local;
  }

  return {
    counts,
    byFile,
    total: BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0),
  };
}

const DOC_RAW = fs.readFileSync(DESIGN_DOC, 'utf8');
const DOCUMENTED = parseDocumentedInventory(DOC_RAW);
const MEASURED = measureInventory();

describe('§2.6 route inventory — the documented figures match the real declarations', () => {
  it('reads the documented inventory sentence', () => {
    assert.ok(
      DOCUMENTED,
      [
        'the §2.6 inventory sentence could not be read.',
        'This guard expects one sentence of the shape:',
        '  "Phase 23 classifies **N routes**: **N permission-gated**, **N authenticated**, **N public**, **N role-gated**."',
        'If the sentence was deliberately reworded, update INVENTORY_PATTERN in this file in the same change.',
      ].join('\n')
    );
  });

  it('agrees on the total', () => {
    assert.equal(
      DOCUMENTED.total,
      MEASURED.total,
      `§2.6 documents ${DOCUMENTED.total} routes; the sources declare ${MEASURED.total}. ` +
        'Update the documented figure (and the split below) rather than this assertion.'
    );
  });

  for (const bucket of BUCKETS) {
    it(`agrees on the ${bucket} tier`, () => {
      assert.equal(
        DOCUMENTED[bucket],
        MEASURED.counts[bucket],
        `§2.6 documents ${DOCUMENTED[bucket]} ${bucket}; the sources declare ${MEASURED.counts[bucket]}. ` +
          'A route was added, removed or re-gated — update §2.6 to match the code.'
      );
    });
  }

  it('is internally consistent — the split sums to the total', () => {
    const sum = BUCKETS.reduce((acc, bucket) => acc + DOCUMENTED[bucket], 0);
    assert.equal(
      sum,
      DOCUMENTED.total,
      `§2.6 states ${DOCUMENTED.total} routes but its four tiers sum to ${sum} — the sentence was updated in part.`
    );
  });

  it('reports no role-gated route while the Phase 23 register declares none', () => {
    assert.equal(
      MEASURED.counts.roleGated,
      0,
      `${MEASURED.counts.roleGated} declaration(s) name requireRole(. A role-name gate is invisible to the ` +
        'permission catalogue and needs an owner decision (Phase 23) — declare it in ROLE_GATED_ROUTES ' +
        'rather than leaving it uncounted here.'
    );
  });

  it('has actually measured a non-degenerate application', () => {
    // Guards this guard: if the scanner broke and found nothing, "0 routes documented, 0 measured"
    // would pass every comparison above while proving nothing.
    assert.ok(
      MEASURED.total > 50 && MEASURED.counts.gated > 40,
      `the scanner found only ${MEASURED.total} routes (${MEASURED.counts.gated} gated) — it is not reading the sources`
    );
  });
});

describe('the guard can fail — in-memory negative control', () => {
  it('rejects the pre-fix figures it was written to catch', () => {
    // The exact sentence §2.6 carried from Phase 32H until 2026-10-12. If a future edit reintroduced
    // it, the comparisons above must fail — so this control proves the mismatch is detectable rather
    // than assuming it. It is also why the figures are captured, not hardcoded.
    const stale = DOC_RAW
      .replace(/\*\*\d+ routes\*\*/, '**68 routes**')
      .replace(/\*\*\d+ authenticated\*\*/, '**11 authenticated**')
      .replace(/\*\*\d+ public\*\*/, '**10 public**');
    const parsed = parseDocumentedInventory(stale);

    assert.ok(parsed, 'the negative control must still parse — otherwise it tests nothing');
    assert.equal(parsed.total, 68);
    assert.equal(parsed.authenticated, 11);
    assert.equal(parsed.public, 10);
    assert.notEqual(parsed.total, MEASURED.total, 'the stale total must differ from the measured one');
    assert.notEqual(
      parsed.authenticated,
      MEASURED.counts.authenticated,
      'the stale authenticated tier must differ from the measured one'
    );
    assert.notEqual(
      parsed.public,
      MEASURED.counts.public,
      'the stale public tier must differ from the measured one'
    );
  });

  it('refuses an unparseable sentence rather than guessing', () => {
    assert.equal(parseDocumentedInventory('Phase 23 classifies some routes in four buckets.'), null);
  });
});
