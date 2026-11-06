// AI-26 — an answer cut off by the output cap must not end mid-row or mid-word.
//
// THE DEFECT, read out of the development database on 2026-10-19 rather than imagined.
// Every stored `OUTPUT_LIMIT` answer (4 of 34 assistant messages) ended inside a Markdown
// table cell:
//
//   … | Professional Battery 10051 |
//   … | 2026‑10‑18 01:48:51 | Professional Towel 1
//   … | Pro Cable 19871 |
//   … | 6ad49
//
// AI-8 was right to KEEP a truncated answer — the first rows are what was asked for — and
// right to mark it. But the bubble then drew a row with a name and no quantities, or a
// name cut in half, with "may be incomplete" underneath. The note explains the truncation;
// it does not make half a row readable.
//
// THE FIX is a deterministic trim of the ONE incomplete unit at the end (AI-26):
// `trimIncompleteAnswer` drops a trailing table row that is cut mid-cell, missing a cell or
// lacking its closing pipe, cuts a paragraph back to its last finished sentence, and
// returns the text UNCHANGED whenever no whole unit can be identified — deleting a correct
// answer to rescue a cut one would be the worse failure.
//
// WHAT IS DELIBERATELY NOT DONE. It does not ask the model to continue: the turn has
// already spent its output budget, another request costs quota (the free tier allows ~50 a
// day), and the result cannot be bounded by the turn's remaining deadline. It also does not
// touch the middle of an answer or a complete list item — a cut item and a whole one look
// alike at the end of a string, so the list case keeps its honest visible truncation.
//
// The service cases run the REAL loop with the fake provider, so what is asserted is what
// `runAiChat` returns and logs, not a copy of the trimming rule.

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { unitSuite } from './testEnv.mjs';
import { ROLES } from '../src/constants/roles.ts';
import { runAiChat, systemPrompt } from '../src/services/ai/ai.service.ts';
import { trimIncompleteAnswer, humaniseStatusConstants } from '../src/services/ai/answerCompletion.ts';
import { registerFakeProvider, setFakeScenario, fakeText } from './fakes/aiProvider.mjs';

process.env.AI_PROVIDER = 'fake';
registerFakeProvider();

afterEach(() => {
  setFakeScenario(null);
});

/** The four real tails, exactly as stored (SUITE: the shapes are the evidence). */
const REAL_TAILS = [
  // A four-column header, and a final row with one cell: the quantities never arrived.
  'Here are the first 20 products from that list:\n\n| Product | Available Qty | Minimum Stock | Status |\n' +
    '|---|---|---|---|\n| Professional Mug 19890 | 69 | 74 | Low stock |\n| Pro Cable 19871 |',
  // A row that never got its closing pipe, so the name itself was cut.
  '| Time | Product | Qty |\n|---|---|---|\n| 2026‑10‑18 01:48:51 | Professional Towel 1',
  // The model was emitting an id when the budget ran out.
  '| Product | Qty | Status |\n|---|---|---|\n| Mug | 2 | Low |\n| 6ad49',
];

unitSuite('AI-26 an incomplete answer loses only its incomplete unit', () => {
  it('★ drops a table row cut mid-cell and keeps every complete row', () => {
    const out = trimIncompleteAnswer(REAL_TAILS[0]);
    assert.ok(!out.endsWith('| Pro Cable 19871 |'), 'the half row is gone');
    assert.ok(out.includes('| Professional Mug 19890 | 69 | 74 | Low stock |'), 'the complete row is kept');
    assert.ok(out.startsWith('Here are the first 20 products'), 'the introduction is untouched');
  });

  it('★ drops a row that never got its closing pipe, so no name is cut in half', () => {
    // Real answers have complete rows before the cut; this one is the whole answer, so the
    // trim would leave a bare header. That is the documented fallback: with no whole unit
    // anywhere the text comes back unchanged, because an empty answer is a worse outcome
    // than a visibly cut one and the note is already drawn. The next case proves the same
    // cut row IS dropped when there is a complete row before it.
    const out = trimIncompleteAnswer(
      '| Time | Product | Qty |\n|---|---|---|\n| 2026‑10‑18 02:10:44 | Value Mug 20011 | 4 |\n' +
        '| 2026‑10‑18 01:48:51 | Professional Towel 1',
    );
    assert.ok(!out.includes('Professional Towel'), 'a cut name is not shown as if it were the name');
    assert.ok(out.includes('| Value Mug 20011 |'), 'the complete row before it is kept');
  });

  it('★ drops a row cut inside an id', () => {
    const out = trimIncompleteAnswer(REAL_TAILS[2]);
    assert.ok(!out.includes('6ad49'), 'the partial id is gone');
    assert.ok(out.includes('| Mug | 2 | Low |'), 'the complete row before it is kept');
  });

  it('drops a row with fewer cells than the header declares', () => {
    const out = trimIncompleteAnswer(
      '| Product | Available | Minimum | Status |\n|---|---|---|---|\n| Mug | 3 | 5 | Low |\n| Cable | 0 |',
    );
    assert.ok(!out.includes('| Cable | 0 |'));
    assert.ok(out.includes('| Mug | 3 | 5 | Low |'));
  });

  it('never touches a complete table', () => {
    const complete = '| Product | Qty |\n|---|---|\n| Mug | 3 |';
    assert.equal(trimIncompleteAnswer(complete), complete);
  });

  it('never touches a complete sentence', () => {
    const complete = 'You have 203 products in inventory. The largest location is the Main Warehouse.';
    assert.equal(trimIncompleteAnswer(complete), complete);
  });

  it('★ cuts a paragraph back to its last finished sentence', () => {
    const out = trimIncompleteAnswer(
      'You have 203 products in inventory. The largest location is the Main Warehouse, which carries all of',
    );
    assert.equal(out, 'You have 203 products in inventory.');
  });

  it('keeps a paragraph that has no finished sentence to fall back on', () => {
    // Nothing whole to keep. Returning the text as it arrived is the honest failure: the
    // "may be incomplete" note is already drawn, and guessing would delete real content.
    const cut = 'The largest location is the Main Warehouse which carr';
    assert.equal(trimIncompleteAnswer(cut), cut);
  });

  it('does not break the closing markdown of a finished sentence', () => {
    const text = 'All of these items show zero units available.\n\n*(The full list is shown on the inventory screen in the app.)*';
    assert.equal(trimIncompleteAnswer(text), text, 'a complete answer is returned untouched');
  });

  it('does not delete a whole list item to rescue a cut one', () => {
    // A list item carries no full stop, so `5. Professional Mug … 0 units available` and the
    // same item cut short look identical at the end of a string. Removing the good one would
    // silently lose data; the note is the honest answer here.
    const text = 'Here are five:\n1. Mug\n2. Cable\n3. Torch';
    assert.equal(trimIncompleteAnswer(text), text);
  });

  it('leaves a header-only table alone when there is no whole content anywhere', () => {
    const text = '| Product | Available |\n|---|---|';
    assert.equal(trimIncompleteAnswer(text), text);
  });

  it('is total: empty and whitespace-only input come back unchanged', () => {
    assert.equal(trimIncompleteAnswer(''), '');
    assert.equal(trimIncompleteAnswer('   \n  '), '   \n  ');
  });
});

unitSuite('AI-26 the stored status constant never reaches the screen', () => {
  // Read off the phone, 2026-10-19: a complete restock answer drew a table whose Status
  // column said OUT_OF_STOCK. The prompt now forbids it, and this is the deterministic
  // half — a prompt is a request, and the member should not read server vocabulary.
  it('★ rewrites every status constant in a member\'s words', () => {
    const out = humaniseStatusConstants(
      '| Product | Status |\n|---|---|\n| Mug | OUT_OF_STOCK |\n| Cable | LOW_STOCK |\n| Torch | IN_STOCK |',
    );
    assert.ok(out.includes('Out of stock'));
    assert.ok(out.includes('Low stock'));
    assert.ok(out.includes('In stock'));
    for (const raw of ['OUT_OF_STOCK', 'LOW_STOCK', 'IN_STOCK']) {
      assert.ok(!out.includes(raw), `${raw} must not reach the stored answer`);
    }
  });

  it('leaves a longer token that merely contains a status alone', () => {
    // `LOW_STOCK_PRODUCTS` is an identifier, not a status; half-rewriting it would turn
    // one internal token into an unreadable hybrid.
    const text = 'Check LOW_STOCK_PRODUCTS and OUT_OF_STOCKED before deciding.';
    assert.equal(humaniseStatusConstants(text), text);
  });

  it('is safe to apply twice and to an empty answer', () => {
    const once = humaniseStatusConstants('Status: OUT_OF_STOCK.');
    assert.equal(humaniseStatusConstants(once), once);
    assert.equal(humaniseStatusConstants(''), '');
  });

  it('★ AI-62 rewrites the movement types too, in the labels the app shows', () => {
    // Device, 2026-11-05 5:19 PM: "there were 538 STOCK_OUT events". These four are the
    // TypeBadge labels on the History screen, so the answer and the screen agree.
    const out = humaniseStatusConstants('538 STOCK_OUT, 12 STOCK_IN, 1 TRANSFER, 1 ADJUSTMENT');
    assert.equal(out, '538 Stock out, 12 Stock in, 1 Transfer, 1 Adjustment');
  });
});

unitSuite('AI-26 the turn returns and reports the completed answer', () => {
  async function turnCapturingLogs(scenario) {
    const lines = [];
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = (...args) => lines.push(args.join(' '));
    console.warn = (...args) => lines.push(args.join(' '));
    try {
      setFakeScenario(scenario);
      const result = await runAiChat({
        businessId: 'b-dummy',
        userId: 'u-dummy',
        role: ROLES.OWNER,
        message: 'what needs restocking?',
      });
      return { result, lines };
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }
  }

  it('★ marks the turn AND returns an answer with no half row', async () => {
    const { result, lines } = await turnCapturingLogs(() => fakeText(REAL_TAILS[0], { truncated: true }));

    assert.equal(result.degraded, 'OUTPUT_LIMIT', 'the mark that AI-8 established is unchanged');
    assert.ok(!result.content.endsWith('| Pro Cable 19871 |'));
    assert.ok(result.content.includes('| Professional Mug 19890 | 69 | 74 | Low stock |'));
    const warn = lines.find((line) => line.includes('degraded turn'));
    assert.ok(warn, 'the degraded warning is still emitted');
    assert.match(warn, /reason=OUTPUT_LIMIT/);
    assert.match(warn, /trimmed=\d+/);
    assert.ok(Number(warn.match(/trimmed=(\d+)/)[1]) > 0, 'the line states how much was removed');
  });

  it('leaves a complete answer alone (no trim, no mark)', async () => {
    const { result, lines } = await turnCapturingLogs(() => fakeText('You have 203 products.'));

    assert.equal(result.degraded, undefined);
    assert.equal(result.content, 'You have 203 products.');
    assert.ok(!lines.some((line) => line.includes('degraded turn')));
  });

  it('★ returns the answer with its status constants already humanised', async () => {
    const { result } = await turnCapturingLogs(() =>
      fakeText('| Product | Status |\n|---|---|\n| Classic Mug | OUT_OF_STOCK |'),
    );

    assert.equal(result.degraded, undefined);
    assert.ok(result.content.includes('| Classic Mug | Out of stock |'));
    assert.ok(!result.content.includes('OUT_OF_STOCK'));
  });
});

unitSuite('AI-26 the prompt stops the jargon that made answers long', () => {
  // The same corpus that held the cut rows held "indicated `hasMore: true`", a 24-character
  // id in a table cell, and "let me know how many additional rows you'd like". Each is a
  // sentence about the server's data shape, and each costs output tokens an answer needs.
  const prompt = systemPrompt();

  it('forbids internal identifiers and raw field names', () => {
    assert.match(prompt, /^14\. Never put internal identifiers or raw field names/m);
    for (const word of ['productId', 'hasMore', 'truncated', 'availableQuantity']) {
      assert.ok(prompt.includes(word), `rule 14 must name \`${word}\` — it was in a stored answer`);
    }
    assert.match(prompt, /24-character hex ids/);
    // The device answer of 2026-10-19 drew `OUT_OF_STOCK` in a Status cell.
    assert.match(prompt, /never OUT_OF_STOCK, LOW_STOCK or IN_STOCK/);
    assert.match(prompt, /write "Product", not "Product \(name\)"/);
  });

  it('replaces "subsequent pages" with the screen that actually shows the list', () => {
    assert.match(prompt, /^15\. When you are showing one page/m);
    assert.match(prompt, /Never ask the member how many rows to show/);
    assert.match(prompt, /never say the rest is "on subsequent pages"/);
    assert.match(prompt, /at most three, and never an id/);
    // It must also demand the TOTAL, because the device answer of 2026-10-19 said the full
    // list was elsewhere without ever saying how long it is.
    assert.match(prompt, /the FIRST sentence must state both numbers/);
  });

  it('asks for the thousands separator the app uses', () => {
    // Two of three device answers at 60 000 products said "8976" while the dashboard and
    // the Restock screen beside them said "8,976". A prompt rule is the only safe fix —
    // a post-processing pass would rewrite the five-digit codes inside product names.
    assert.match(prompt, /^4\. Report exact numbers/m);
    assert.match(prompt, /"8,976", not "8976"/);
    assert.match(prompt, /except inside a product name, a SKU or a date/);
  });

  it('names the screens in the app and rules out the invented one', () => {
    // Rule 15 used to refer to "the screen named in rule 3" — and rule 3 named no screen,
    // which is why the model invented "Reorder needed" (the tool's name) on the phone.
    assert.match(prompt, /"Restock" for anything low, out of stock or needing restocking/);
    assert.match(prompt, /There is no "Reorder needed" screen/);
  });
});
