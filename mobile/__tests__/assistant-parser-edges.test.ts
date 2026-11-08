/**
 * Ways a marker reached the screen or moved a column (§27DA, §27DB).
 *
 * Found by probing the parser with realistic model output rather than by reading it:
 *
 *  1. **`\|` inside a table cell was treated as a column boundary.** `| A \| B | 3 |` is Markdown's own way to
 *     put a pipe in a cell, and the splitter produced three cells — `A`, `B`, `3` — so every later value in that
 *     row sat one column left of the header it belongs to. A table is the one structure where a shifted value is
 *     not merely ugly: the quantity under "Qty" is then a product name. The split now protects the escaped pipe
 *     and restores it inside the cell.
 *  2. **`~~strikethrough~~` was not stripped at all.** The residual pass exists so that a marker the renderer
 *     does not model cannot reach the screen; `~~old~~ new` reached it with both tilde pairs intact. It is now
 *     removed under the same word-boundary rule as every other marker, so `a~~b~~c` — data, not formatting —
 *     is left alone, exactly as `SKU_123_AB` is for underscores and `4*5*6` is for asterisks.
 *
 * Both are pinned in the plain text path and inside a table cell, because the cell is where the two rules meet.
 *
 *  3. **A truncated answer showed its dangling opener** (§27DB). Found by replaying all 50 stored assistant
 *     answers through the renderer rather than by writing a sample: the only leak class in real output was in
 *     the two turns that hit their output budget mid-marker — `… (the system has **71,07` and a numbered
 *     `11. **2` — so the last thing on screen was a pair of asterisks. No other answer leaked anything (no
 *     links, brackets, blockquotes or HTML in 50 turns), which is why the fix is a marker rule and not the
 *     link rule the previous increment left open.
 */
import { parseAssistantMarkdown, parseInline, stripMarkdown } from '../lib/assistantMarkdown';
import type { Block, Row } from '../lib/assistantMarkdown';

const flat = (cells: Row): string[] => cells.map((cell) => cell.map((span) => span.text).join(''));

function tableOf(text: string): Extract<Block, { kind: 'table' }> {
  const table = parseAssistantMarkdown(text).find((b) => b.kind === 'table');
  if (!table) throw new Error('expected a table');
  return table;
}

describe('a pipe may be data', () => {
  it('★ an escaped pipe stays inside its cell, and the columns after it stay aligned', async () => {
    const table = tableOf('| Product | Qty |\n| --- | --- |\n| A \\| B | 3 |\n| C | 4 |');

    expect(table.header.length).toBe(2);
    expect(table.rows.length).toBe(2);
    expect(flat(table.rows[0])).toEqual(['A | B', '3']);
    // The row that has no escape is untouched — the fix cannot be a behaviour change for ordinary tables.
    expect(flat(table.rows[1])).toEqual(['C', '4']);
  });

  it('a row ending in an escaped pipe keeps it, because it is data rather than the closing edge', async () => {
    const table = tableOf('| Note |\n| --- |\n| x \\|');
    expect(flat(table.rows[0])).toEqual(['x |']);
  });

  it('an ordinary table is unchanged — no edge pipes, and the separator row is still not a row', async () => {
    const table = tableOf('Product | Qty\n--- | ---\nA | 3');
    expect(flat(table.header)).toEqual(['Product', 'Qty']);
    expect(table.rows.map(flat)).toEqual([['A', '3']]);
  });
});

describe('backslash-escaped markers render as the literal character', () => {
  it('a \\* footnote marker shows as * with no backslash on the screen', async () => {
    expect(stripMarkdown('Price is ₱6,000.00\\*')).toBe('Price is ₱6,000.00*');
    expect(parseInline('Price is ₱6,000.00\\*').map((s) => s.text).join('')).toBe(
      'Price is ₱6,000.00*',
    );
  });

  it('an escaped star never opens emphasis', async () => {
    expect(stripMarkdown('\\*not bold\\* here')).toBe('*not bold* here');
  });
});

describe('strikethrough is a marker like any other', () => {
  it('★ paired tildes are removed, so no marker reaches the screen', async () => {
    expect(stripMarkdown('~~old~~ new')).toBe('old new');
    expect(stripMarkdown('Price is ~~$5~~ $4')).toBe('Price is $5 $4');
  });

  it('tildes inside a word are data, under the same boundary rule as every other marker', async () => {
    expect(stripMarkdown('a~~b~~c')).toBe('a~~b~~c');
  });

  it('a lone tilde survives — "~5 minutes" is not formatting', async () => {
    expect(stripMarkdown('~5 minutes')).toBe('~5 minutes');
  });

  it('a cell is stripped too, because the cell is where the two rules meet', async () => {
    const table = tableOf('| Status |\n| --- |\n| ~~gone~~ ok |');
    expect(flat(table.rows[0])).toEqual(['gone ok']);
  });
});

describe("a truncated answer's dangling opener is not punctuation on the screen", () => {
  it('★ the measured tail loses its opener and keeps the number', async () => {
    // Verbatim from a stored answer that hit its output budget: the member saw `**71,07`.
    expect(stripMarkdown('…and 15 more movements in this page (the system has **71,07')).toBe(
      '…and 15 more movements in this page (the system has 71,07',
    );
  });

  it('★ the measured numbered item — an opener with nothing after it — renders as its text', async () => {
    expect(parseInline('**2')).toEqual([{ text: '2' }]);
  });

  it('the same rule covers a dangling strikethrough and an unclosed code span', async () => {
    expect(stripMarkdown('was ~~gone')).toBe('was gone');
    expect(stripMarkdown('SKU `DEMO-')).toBe('SKU DEMO-');
  });

  it('well-formed markup is untouched — a pair is still a pair', async () => {
    expect(parseInline('**bold** text')).toEqual([{ text: 'bold', bold: true }, { text: ' text' }]);
    expect(stripMarkdown('**a** and **b')).toBe('a and b');
  });

  it('the arithmetic and identifier limits AI-4 accepted are unchanged', async () => {
    // The three conditions cannot fire here: no boundary before the run, or a word after it.
    expect(stripMarkdown('4**5')).toBe('4**5');
    expect(stripMarkdown('12 * 3 = 36')).toBe('12 * 3 = 36');
    expect(stripMarkdown('SKU_123_AB')).toBe('SKU_123_AB');
  });

  it('an opener followed by a space is not half-cleaned', async () => {
    // `(?=\S)` is the reason: an opener has content after it, and guessing here would be markup removal by
    // hope rather than by rule.
    expect(stripMarkdown('** a')).toBe('** a');
  });
});

/**
 * 4. **A source link reached the screen as its own markup** (2026-11-04, on the phone).
 *
 * The research tools quote where a fact came from, so their answers arrive with `[Keychron Philippines product
 * page](https://keychron.ph/…)` and, from some models, the bare autolink `<https://techpickstream.com/…>`. The
 * device run showed both literally — brackets, angle brackets and the URL — inside the bubble, which left the one
 * thing that makes a researched price checkable (its source) unusable. They now parse into a span carrying
 * `href`, which the renderer opens with `Linking`.
 *
 * Only `http(s)` is a link: research output never needs another scheme, and treating one as tappable is how a
 * rendered answer could be made to run an intent. Anything else stays the text the model wrote.
 */
describe('a quoted source is a link, not markup', () => {
  it('★ the measured answer — a labelled link — keeps its label and carries its address', async () => {
    const [link] = parseInline('[Kechron Philippines product page](https://keychron.ph/products/keychron-k8-pro) (public-page source)');

    expect(link).toEqual({ text: 'Kechron Philippines product page', href: 'https://keychron.ph/products/keychron-k8-pro' });
    expect(stripMarkdown('[Kechron Philippines](https://keychron.ph/x)')).toBe('[Kechron Philippines](https://keychron.ph/x)');
  });

  it('★ an autolink becomes the bare address', async () => {
    expect(parseInline('<https://techpickstream.com/general/how-good-is-the-keychron-k8-pro-keyboard>')).toEqual([
      { text: 'https://techpickstream.com/general/how-good-is-the-keychron-k8-pro-keyboard', href: 'https://techpickstream.com/general/how-good-is-the-keychron-k8-pro-keyboard' },
    ]);
  });

  it('★ the server source list is a tappable address, not bracket markup', async () => {
    const list = parseAssistantMarkdown('Source URLs:\n- Review: <https://example.com/review>').find(
      (block) => block.kind === 'list',
    ) as Extract<Block, { kind: 'list' }>;
    expect(list.items[0].spans).toEqual([
      { text: 'Review: ' },
      { text: 'https://example.com/review', href: 'https://example.com/review' },
    ]);
  });

  it('a link inside a list item and a table cell is still a link', async () => {
    const list = parseAssistantMarkdown('- ₱6,000.00 on [keychron.ph](https://keychron.ph/p)');
    const item = (list[0] as Extract<Block, { kind: 'list' }>).items[0];
    expect(item.spans.some((span) => span.href === 'https://keychron.ph/p')).toBe(true);

    const table = tableOf('| Source | Price |\n| --- | --- |\n| [keychron.ph](https://keychron.ph/p) | 6000 |');
    expect(table.rows[0][0][0]).toEqual({ text: 'keychron.ph', href: 'https://keychron.ph/p' });
  });

  it('only http(s) is a link; anything else stays the text it was', async () => {
    expect(parseInline('[tap me](javascript:alert(1))')).toEqual([{ text: '[tap me](javascript:alert(1))' }]);
    expect(parseInline('fewer than < 5 units')).toEqual([{ text: 'fewer than < 5 units' }]);
  });

  it('an unclosed label or address does not eat the rest of the line', async () => {
    expect(parseInline('[Keychron PH](https://keychron.ph').map((span) => span.text)).toEqual(['[Keychron PH](https://keychron.ph']);
    expect(parseInline('a [note] here').map((span) => span.text)).toEqual(['a [note] here']);
  });
});
