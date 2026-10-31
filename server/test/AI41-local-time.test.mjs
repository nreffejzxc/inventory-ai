// AI-41 — the assistant's dates are the member's, not UTC's.
//
// WHY THIS EXISTS. `systemPrompt()` said `Today is <UTC date>` and the history tool
// handed the model raw ISO instants. A member in Manila asking "what moved today?"
// at 07:00 was answered for the previous UTC day, and every quoted time was eight
// hours off — an accuracy defect in the one feature whose promise is that it does
// not invent facts. The fix is a per-turn zone: the prompt is told the member's
// local date and time, and every tool row that carries an instant also carries
// `localTime` in that zone, because a model asked to convert is a model guessing.
//
// WHAT THIS SUITE PINS:
//   * the day boundary itself — one instant that is a different calendar date in
//     Tokyo and in UTC, asserted in both directions;
//   * the formatter's exact output, so a locale or ICU change cannot silently
//     reorder a date;
//   * an unknown/absent zone falling back to UTC rather than failing a turn;
//   * the history AND dashboard tool rows actually carrying the local value, so
//     the unit-level promise is not disconnected from what the model reads.

import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, makeApi, createTracker, registerOwner, uniqueName, disconnectDb } from './support.mjs';
import { dbSuite, unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { executeTool } from '../src/services/ai/tools.ts';
import { systemPrompt } from '../src/services/ai/ai.service.ts';
import { localDate, localDateTime, resolveTimeZone } from '../src/utils/timeZone.ts';

unitSuite('AI-41 the assistant speaks the member’s clock', () => {
  // 23:30 UTC on 1 November is already 08:30 on 2 November in Tokyo. This is the
  // awkward hour: the UTC date is the PREVIOUS day for a large part of the world,
  // which is exactly when the old prompt was wrong.
  const boundary = new Date('2026-11-01T23:30:00.000Z');

  it('★ one instant is two different days, and the prompt names the member’s', () => {
    const tokyo = systemPrompt({ timeZone: 'Asia/Tokyo', now: boundary });
    assert.match(tokyo, /2026-11-02/, 'the member’s local date is not in the prompt');
    assert.doesNotMatch(tokyo, /2026-11-01/, 'the UTC date leaked into a Tokyo prompt');
    assert.match(tokyo, /08:30/, 'the member’s local time is not in the prompt');

    const utc = systemPrompt({ timeZone: 'UTC', now: boundary });
    assert.match(utc, /2026-11-01/, 'UTC stopped being the fallback clock');
    assert.match(utc, /23:30/);
  });

  it('★ a zone ahead of UTC crosses the day forward, not backward', () => {
    // Kiritimati is UTC+14: midday UTC is already the next calendar day.
    assert.equal(localDate(new Date('2026-11-01T12:00:00.000Z'), 'Pacific/Kiritimati'), '2026-11-02');
    assert.equal(localDate(new Date('2026-11-01T09:59:00.000Z'), 'Pacific/Kiritimati'), '2026-11-01');
  });

  it('★ the quoted form is stable date-then-24h-time', () => {
    assert.equal(localDateTime(boundary, 'Asia/Tokyo'), '2026-11-02 08:30');
    assert.equal(localDateTime(boundary, 'UTC'), '2026-11-01 23:30');
    // Midnight must be 00:00, never 24:00.
    assert.equal(localDateTime(new Date('2026-11-01T15:00:00.000Z'), 'Asia/Tokyo'), '2026-11-02 00:00');
  });

  it('★ an unknown or absent zone falls back to UTC instead of failing the turn', () => {
    assert.equal(resolveTimeZone('Mars/Olympus'), 'UTC');
    assert.equal(resolveTimeZone(''), 'UTC');
    assert.equal(resolveTimeZone(undefined), 'UTC');
    assert.equal(resolveTimeZone({ zone: 'Asia/Tokyo' }), 'UTC');
    assert.equal(resolveTimeZone('x'.repeat(200)), 'UTC');

    const prompt = systemPrompt({ timeZone: 'Mars/Olympus', now: boundary });
    assert.match(prompt, /UTC/);
    assert.match(prompt, /2026-11-01/);
  });

  it('★ the prompt points the model at localTime and forbids showing UTC', () => {
    const prompt = systemPrompt({ timeZone: 'Asia/Manila', now: boundary });
    assert.match(prompt, /localTime/, 'the model is never told which field to quote');
    assert.match(prompt, /never show a raw ISO\/UTC timestamp/i);
    assert.match(prompt, /GMT\+08:00/, 'the offset that bounds a local day is missing');
  });
});

const { dbOk, baseUrl, server } = await startServer();
const api = makeApi(baseUrl);
const tracker = createTracker(dbOk);

dbSuite('AI-41 the tool rows the model reads carry the member’s local time', dbOk, () => {
  let owner;
  let location;
  let productId;

  before(async () => {
    owner = await registerOwner(api, tracker);
    const created = await api('POST', '/api/locations', { token: owner.token, body: { name: uniqueName('TZLoc') } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    location = created.json;

    const product = await api('POST', '/api/products', { token: owner.token, body: { name: uniqueName('TZProd') } });
    assert.equal(product.status, 201, JSON.stringify(product.json));
    productId = product.json.id;

    const stocked = await api('POST', '/api/inventory/stock-in', {
      token: owner.token,
      body: { productId, locationId: location.id, quantity: 3 },
    });
    assert.equal(stocked.status, 201, JSON.stringify(stocked.json));
  });

  after(async () => {
    await tracker.cleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  });

  const ctxFor = (timeZone) => ({
    businessId: owner.businessId,
    userId: owner.userId,
    role: ROLES.OWNER,
    timeZone,
  });

  it('★ a history row carries localTime in the member’s zone, beside the instant', async () => {
    const res = await executeTool('getInventoryHistory', { location: location.name }, ctxFor('Pacific/Kiritimati'));
    assert.equal(res.ok, true, JSON.stringify(res));
    const row = res.result.items.find((item) => item.product?.id === productId);
    assert.ok(row, 'the stock-in just created is missing from the page');

    const instant = new Date(row.createdAt);
    assert.equal(row.localTime, localDateTime(instant, 'Pacific/Kiritimati'));
    // UTC+14 can never coincide with UTC, so this is a real assertion that the zone
    // was applied rather than echoed.
    assert.notEqual(row.localTime, localDateTime(instant, 'UTC'));
    assert.equal(row.localTime.slice(0, 10), localDate(instant, 'Pacific/Kiritimati'));
  });

  it('★ the dashboard summary’s recent activity is rendered the same way', async () => {
    const res = await executeTool('getInventorySummary', {}, ctxFor('Asia/Manila'));
    assert.equal(res.ok, true, JSON.stringify(res));
    const item = res.result.recentActivity.find((row) => row.product?.id === productId);
    assert.ok(item, 'the stock-in just created is missing from the dashboard activity');
    assert.equal(item.localTime, localDateTime(new Date(item.createdAt), 'Asia/Manila'));
  });

  it('★ without a zone the payload keeps its old shape (older clients unchanged)', async () => {
    const res = await executeTool('getInventoryHistory', { location: location.name }, ctxFor(undefined));
    assert.equal(res.ok, true, JSON.stringify(res));
    const row = res.result.items.find((item) => item.product?.id === productId);
    assert.ok(row);
    assert.equal('localTime' in row, false);
  });
});
