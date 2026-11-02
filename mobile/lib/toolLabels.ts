/**
 * AI-21 — the provenance chip in a member's language, not the server's.
 *
 * WHY THIS EXISTS. Every assistant answer ends with a small grey line naming the tools that
 * produced it — `Read: getProductsByLocation` — because the trace is what makes an answer
 * checkable. The owner's judgement, after seeing it on the phone, is that an internal
 * identifier is jargon a member should not have to decode: the chip should say what was
 * READ, not which function read it.
 *
 * WHAT THIS DOES NOT DO. It does not hide the trace or change what the server records: the
 * stored message keeps the real names, `restockPathForTools` still keys off them, and the
 * app's own logs and the server's turn line are untouched. Only the sentence drawn on the
 * bubble is translated.
 *
 * THE FALLBACK IS THE POINT. A tool added on the server later must not render as an
 * identifier just because this table was not updated, so anything unknown is humanised —
 * `getWidgetStats` reads as "Widget stats" — and a name that cannot be humanised still
 * never reaches the screen raw (see `toolLabel`).
 */

/**
 * The tools this build knows by name. Mirrors `server/src/services/ai/tools.ts`; the
 * fallback below is what covers a name added after this file was written, which is why a
 * missing entry is a cosmetic defect rather than a leak.
 */
const TOOL_LABELS: Record<string, string> = {
  getInventorySummary: 'Inventory summary',
  getInventory: 'Inventory rows',
  getProductsByLocation: 'Products at a location',
  getInventoryHistory: 'Stock movements',
  getLowStockProducts: 'Low-stock products',
  getOutOfStockProducts: 'Out-of-stock products',
  getReorderNeededProducts: 'Restock list',
  searchProducts: 'Product search',
  findProducts: 'Product discovery',
  getProduct: 'Product details',
  listLocations: 'Locations',
  listCategories: 'Categories',
  listBrands: 'Brands',
  // AI-23's one read. Named here rather than left to the humanising fallback: a label is a
  // deliberate word, and the parity test fails when a read is added to the server without
  // a decision made here.
  getLocationBreakdown: 'Stock by location',
};

/**
 * Turn an unknown tool name into something a member can read.
 *
 * `getWidgetStats` -> "Widget stats": the leading verb is dropped (every tool here reads —
 * that is what the chip already says), camelCase is split, and only the first word is
 * capitalised so the result reads like a label rather than a sentence. Deliberately total:
 * it must return something for ANY string, because the alternative is an identifier on the
 * screen.
 */
function humanise(tool: string): string {
  const words = tool
    .replace(/^(get|list)/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  // Nothing to read, or nothing but digits/punctuation — a name like `123` is not a label,
  // and returning it unchanged would put a bare identifier-shaped string on the chip. The
  // fallback says something true about every tool instead: this answer read the member's data.
  if (!/[a-z]/.test(words)) return 'Your data';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The member-facing label for one tool name. Never returns the raw name. */
export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? humanise(tool);
}

/**
 * The chip's text for a turn's tools: `"Products at a location · Stock movements"`, or
 * `null` when there is nothing to say. De-duplicated, because a turn can call one tool
 * twice and "Restock list · Restock list" is noise.
 */
export function toolTrace(tools?: string[]): string | null {
  if (!tools?.length) return null;
  const labels: string[] = [];
  for (const tool of tools) {
    const label = toolLabel(tool);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join(' · ');
}

export default { toolLabel, toolTrace };
