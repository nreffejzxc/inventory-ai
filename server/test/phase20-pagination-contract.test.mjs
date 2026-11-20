// Phase 20C (L-1) — the offset-pagination coercion contract, asserted as shipped.
//
// `parsePagination()` (src/utils/pagination.js) does not reject a bad page or
// limit; it silently coerces it and answers 200. That is the actual V1 contract:
// page defaults to 1, limit defaults to 20, limit is capped at 100, and `page`
// past the end is an empty page rather than a 404. This suite PINS that behavior
// so a future change to it has to be deliberate — it documents what the code
// does today and deliberately does not assert what it "ought" to do.
//
// One Phase 20B finding is still not this file's subject:
//   * M-1 — an invalid `status`/`type` filter is coerced rather than rejected.
//     Phase 20D has since normalized that: see phase20-filter-contract.test.mjs
//     for the rejected-filter contract.
//
// M-4 (integer parsing) IS covered here now. `Number.parseInt` is a PREFIX
// parser: it read the longest leading integer and discarded the rest, so
// `limit=1e3` arrived as `1` — which passed both the `>= 1` guard and the cap,
// was echoed back as a legitimate `limit: 1`, and answered a client that asked
// for a thousand rows with exactly one. A page/limit is now usable only when the
// WHOLE value is an integer; every other spelling takes the same default `abc`
// always took. The coercion contract above is unchanged — still 200, still
// coerced, still never rejected.
//
// One representative list route is enough: `parsePagination` is shared by every
// paginated endpoint, and the Phase 20A suite already exercises the ordering of
// each individual list. DB-backed; registered as PURE_DB in run-tests.mjs.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer,
  makeApi,
  createTracker,
  registerOwner,
  uniqueName,
  disconnectDb,
} from './support.mjs';
import { dbSuite } from './testEnv.mjs';

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

/** Three products is enough to page over and to sit well inside one page. */
const SEEDED = 3;
const PATH = '/api/products';

let owner; // the business whose catalog is paged

/**
 * GET the list route with raw query fragments appended verbatim, so the exact
 * spelling the client sent is what reaches the parser (no URLSearchParams
 * normalisation in between).
 */
async function listPage(query = '') {
  const res = await api('GET', `${PATH}${query}`, { token: owner.token });
  assert.equal(res.status, 200, `${PATH}${query} -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

dbSuite('Phase 20C — offset pagination coercion contract', dbOk, () => {
  before(async () => {
    owner = await registerOwner(api, tracker);
    for (let i = 0; i < SEEDED; i += 1) {
      const res = await api('POST', PATH, {
        token: owner.token,
        body: { currency: 'PHP', name: uniqueName('P20C') },
      });
      assert.equal(res.status, 201, `product create -> ${res.status} ${JSON.stringify(res.json)}`);
    }
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  it('returns the standard pagination envelope and nothing else', async () => {
    const body = await listPage();
    assert.deepEqual(
      Object.keys(body).sort(),
      ['items', 'limit', 'page', 'total', 'totalPages'],
      'the envelope is exactly { items, page, limit, total, totalPages }'
    );
    assert.ok(Array.isArray(body.items), 'items is an array');
    assert.equal(body.total, SEEDED, 'total is the full count, not the page length');
    assert.equal(body.totalPages, Math.ceil(SEEDED / body.limit), 'totalPages follows the coerced limit');
  });

  it('defaults an omitted page to 1 and an omitted limit to 20', async () => {
    const body = await listPage();
    assert.equal(body.page, 1, 'page omitted -> 1');
    assert.equal(body.limit, 20, 'limit omitted -> 20');
    assert.equal(body.items.length, SEEDED, 'every seeded row is on page 1');
  });

  it('coerces an unusable page to 1 instead of rejecting it', async () => {
    for (const [label, query] of [
      ['page=0', '?page=0'],
      ['page=-1', '?page=-1'],
      ['page=abc', '?page=abc'],
      ['page empty', '?page='],
    ]) {
      const body = await listPage(query);
      assert.equal(body.page, 1, `${label} -> page 1`);
      assert.equal(body.total, SEEDED, `${label}: total is unaffected`);
      assert.equal(body.items.length, SEEDED, `${label}: page 1 is still the first page`);
    }
  });

  it('coerces an unusable limit to the default instead of rejecting it', async () => {
    for (const [label, query] of [
      ['limit=0', '?limit=0'],
      ['limit=-1', '?limit=-1'],
      ['limit=abc', '?limit=abc'],
      ['limit empty', '?limit='],
    ]) {
      const body = await listPage(query);
      assert.equal(body.limit, 20, `${label} -> limit 20`);
      assert.equal(body.total, SEEDED, `${label}: total is unaffected`);
      assert.equal(body.items.length, SEEDED, `${label}: the default limit still fits every row`);
      assert.equal(body.totalPages, 1, `${label}: totalPages follows the coerced limit`);
    }
  });

  it('caps an over-maximum limit at 100 rather than rejecting it', async () => {
    const body = await listPage('?limit=101');
    assert.equal(body.limit, 100, 'limit=101 -> 100');
    assert.equal(body.total, SEEDED, 'total is unaffected by the cap');
    assert.equal(body.items.length, SEEDED, 'all seeded rows still fit');
  });

  it('answers a page past the end with an empty page, not an error', async () => {
    const body = await listPage('?page=99&limit=2');
    assert.equal(body.page, 99, 'the requested page is echoed back');
    assert.equal(body.limit, 2, 'the limit is echoed back');
    assert.equal(body.total, SEEDED, 'total still describes the whole collection');
    assert.equal(body.totalPages, Math.ceil(SEEDED / 2), 'totalPages is unchanged by the page number');
    assert.deepEqual(body.items, [], 'past the final page is an empty page');
  });

  it('applies the coerced values to the window, not just the echo', async () => {
    // The last page holds the remainder, which proves skip = (page-1)*limit is
    // computed from the COERCED page and limit.
    const body = await listPage('?page=2&limit=2');
    assert.equal(body.page, 2);
    assert.equal(body.limit, 2);
    assert.equal(body.items.length, SEEDED - 2, 'page 2 at limit 2 is the one-row remainder');
  });

  // -- M-4: an integer is the WHOLE value, not its leading digits -------------

  it('treats a non-integer spelling as unusable instead of parsing its prefix', async () => {
    // Every one of these used to parse as the digits preceding the offending
    // character: 1e3 -> 1, 10.5 -> 10, 10abc -> 10. Asserting the `limit` echo
    // alone would not have caught that, so the window is asserted too — at
    // limit 1 the old parser answered with a one-row page.
    for (const [label, query] of [
      ['limit=1e3', '?limit=1e3'],
      ['limit=1e2', '?limit=1e2'],
      ['limit=10.5', '?limit=10.5'],
      ['limit=10abc', '?limit=10abc'],
      ['limit=0x10', '?limit=0x10'],
      ['limit with a literal plus', '?limit=%2B10'],
    ]) {
      const body = await listPage(query);
      assert.equal(body.limit, 20, `${label} -> limit 20`);
      assert.equal(body.total, SEEDED, `${label}: total is unaffected`);
      assert.equal(body.items.length, SEEDED, `${label}: the default limit still fits every row`);
      assert.equal(body.totalPages, 1, `${label}: totalPages follows the default limit`);
    }
  });

  it('applies the same integer contract to the page number', async () => {
    // `page=2e0` is the sharp one: it silently meant page 2, and with three rows
    // at the default limit page 2 is empty — so the request looked successful
    // and returned nothing.
    for (const [label, query] of [
      ['page=2e0', '?page=2e0'],
      ['page=1e3', '?page=1e3'],
      ['page=10.5', '?page=10.5'],
    ]) {
      const body = await listPage(query);
      assert.equal(body.page, 1, `${label} -> page 1`);
      assert.equal(body.items.length, SEEDED, `${label}: page 1 holds every row`);
    }

    // A whole-value integer page still works, and still moves the window.
    const second = await listPage('?page=2&limit=2');
    assert.equal(second.page, 2, 'page=2 is still page 2');
    assert.equal(second.items.length, SEEDED - 2, 'page 2 is still the remainder');
  });

  it('keeps the integer spellings that were always valid', async () => {
    // These parsed as integers before the fix and must keep doing so. The
    // coercion cases (abc, 0, -1, blank) and the cap (101) are already pinned
    // above and are deliberately not restated here.
    const padded = await listPage('?limit=0010');
    assert.equal(padded.limit, 10, 'leading zeros are still an integer');
    assert.equal(padded.items.length, SEEDED, 'and the window follows it');

    const fifty = await listPage('?limit=50');
    assert.equal(fifty.limit, 50, 'an ordinary integer is unchanged');

    // A literal `+` in a query string decodes to a space and surrounding
    // whitespace is trimmed, so the common `?limit=+10` spelling keeps working.
    const plussed = await listPage('?limit=+10');
    assert.equal(plussed.limit, 10, 'a decoded +10 still reads as 10');
  });

  it('answers the default when a page or limit is sent twice', async () => {
    // A repeated parameter arrives as an array. It used to be String()-coerced
    // into '2,3' and parsed as 2 — silently honouring the first value of a
    // contradicted pair. An array is not a page/limit value, so it takes the
    // default like any other unusable input.
    const twice = await listPage('?limit=2&limit=3');
    assert.equal(twice.limit, 20, 'a repeated limit falls back to the default');
    assert.equal(twice.items.length, SEEDED, 'and the full page is returned');

    const paged = await listPage('?page=2&page=3');
    assert.equal(paged.page, 1, 'a repeated page falls back to page 1');
    assert.equal(paged.items.length, SEEDED, 'and page 1 holds every row');
  });
});
