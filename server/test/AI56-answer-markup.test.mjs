import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAnswerMarkup } from '../src/services/ai/answerCompletion.ts';

test('AI-56: <br> becomes a line break and other tags are removed', () => {
  const out = normaliseAnswerMarkup('PC Express: PHP 205,995 (search-snippet) <br>• PC Express: PHP 139,995');
  assert.equal(out, 'PC Express: PHP 205,995 (search-snippet)\n• PC Express: PHP 139,995');
  assert.ok(!/<\/?[a-z]/i.test(out));
});

test('AI-56: bold and paragraph tags are dropped, text kept', () => {
  assert.equal(normaliseAnswerMarkup('<p>The <b>ROG</b> costs PHP 89,995.</p>'), 'The ROG costs PHP 89,995.');
});

test('AI-56: common character references are decoded', () => {
  assert.equal(normaliseAnswerMarkup('Tom &amp; Jerry &lt;3 &quot;x&quot;'), 'Tom & Jerry <3 "x"');
});

test('AI-56: a bare comparison sign and plain text are left alone', () => {
  assert.equal(normaliseAnswerMarkup('Stock is < 5 units, so reorder.'), 'Stock is < 5 units, so reorder.');
  assert.equal(normaliseAnswerMarkup(''), '');
});
