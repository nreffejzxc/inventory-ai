/**
 * AI-72 — a business-wide question must not be answered inside last turn's shelf.
 *
 * Measured on the phone 2026-11-05 7:25 PM. After "Any dead stock at the Front Counter?", the
 * follow-up "What has never left the store at all?" came back "At the Front Counter there is no
 * dead stock" — the scope word was read past and the location was carried over, so a question
 * about the whole business was answered for one shelf. Re-asking the model for the wide read was
 * tried and failed (7:32 PM: six iterations, 51 s, still "no products have never left the store"),
 * so the turn loop now drops `location`/`locationId` from the call BEFORE it runs whenever the
 * question names the whole business and does not name that place. This file pins the predicate
 * that decides "names the whole business".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  asksBusinessWide,
  relabelBusinessWideScope,
  scopedPlaceIn,
} from '../src/services/ai/answerCompletion.ts';

test('AI-72 — wording that names the whole business is recognised', () => {
  for (const question of [
    'What has never left the store at all?',
    'Which products have never sold anywhere?',
    'What is not selling across the whole business?',
    'How much stock do we have in total?',
    'What is my dead stock everywhere?',
    'Do we have any dead stock at all',
    'Show me stock across all locations',
    'What is tied up overall?',
  ]) {
    assert.equal(asksBusinessWide(question), true, question);
  }
});

test('AI-72 — a question that names no whole-business scope is left alone', () => {
  for (const question of [
    'Any dead stock at the Front Counter?',
    'Which products have never sold?',
    'What is not selling right now?',
    'Which products sold the most this week?',
    'Where are the G304s?',
    'How much is Main Warehouse worth?',
    '',
  ]) {
    assert.equal(asksBusinessWide(question), false, question);
  }
});

test('AI-72 — a wide read narrated as the dropped place is relabelled', () => {
  // Measured on the phone 2026-11-05 11:02 PM: the business-wide read returned 59 and every
  // sentence around it said Main Warehouse, whose own count is 92.
  const answer = [
    '**Products that have never had a stock-out recorded at Main Warehouse: 59 items.**',
    '',
    '| Product | Available at Main Warehouse |',
    '| A | 12 pcs |',
    '',
    'Nothing has left the shelf at the Main Warehouse since the ledger began.',
  ].join('\n');
  const fixed = relabelBusinessWideScope(answer, 'Main Warehouse');
  assert.equal(fixed.includes('Main Warehouse'), false);
  assert.match(fixed, /recorded across all locations: 59 items/);
  assert.match(fixed, /Available across all locations/);
  assert.match(fixed, /across all locations since the ledger began/);
});

test('AI-72 — the relabel leaves an answer that never names the place alone', () => {
  const answer = '59 products across all locations have no stock-out on record.';
  assert.equal(relabelBusinessWideScope(answer, 'Main Warehouse'), answer);
  assert.equal(relabelBusinessWideScope(answer, ''), answer);
  assert.equal(relabelBusinessWideScope('', 'Main Warehouse'), '');
});

test('AI-72 — a place name with punctuation is matched literally, case-insensitively', () => {
  const answer = 'Stock at st. mary\u2019s annex: 4 items, and ST. MARY\u2019S ANNEX holds 3.';
  const fixed = relabelBusinessWideScope(answer, 'St. Mary\u2019s Annex');
  assert.equal(/mary/i.test(fixed), false);
  assert.match(fixed, /across all locations: 4 items/);
});

test('AI-72 — a scope sentence names the place even when no tool was scoped', () => {
  const answer = 'At Main Warehouse there are 92 products with no stock-out on record.';
  assert.equal(scopedPlaceIn(answer, ['Main Warehouse', 'Shop Front'], 'What has never left the store at all?'), 'Main Warehouse');
  assert.equal(scopedPlaceIn('Nothing left the shelf at the Shop Front.', ['Main Warehouse', 'Shop Front'], 'What never moved anywhere?'), 'Shop Front');
});

test('AI-72 — a per-location breakdown is not a false scope', () => {
  const answer = 'At Main Warehouse 40 products, at Shop Front 19 products have never moved.';
  assert.equal(scopedPlaceIn(answer, ['Main Warehouse', 'Shop Front'], 'What never moved anywhere?'), null);
});

test('AI-72 — a bare mention and a place the question names are left alone', () => {
  assert.equal(scopedPlaceIn('Main Warehouse holds the most stock.', ['Main Warehouse'], 'What is our stock in total?'), null);
  assert.equal(scopedPlaceIn('At Main Warehouse 4 products.', ['Main Warehouse'], 'What is not selling at Main Warehouse?'), null);
  assert.equal(scopedPlaceIn('At the main warehouse 4 products.', ['Main Warehouse'], 'What is not selling?'), 'Main Warehouse');
  assert.equal(scopedPlaceIn('No place named.', [], 'What is not selling?'), null);
});

test('AI-72 — a place named in the question keeps the guard out of the way', () => {
  // The guard also requires that the question does NOT name the place the read was scoped to,
  // so a member asking "any dead stock at the Front Counter at all?" is answered there.
  const question = 'Any dead stock at the Front Counter at all?';
  assert.equal(asksBusinessWide(question), true);
  assert.equal(question.toLowerCase().includes('front counter'), true);
});
