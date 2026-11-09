/**
 * Normalize the punctuation a model or phone keyboard may substitute into an
 * identifier. SKUs and barcodes are stored with ASCII punctuation, but models
 * routinely emit non-breaking hyphens (U+2011) when copying `SEEDSKU-964`.
 * Those differ byte-for-byte, so an exact lookup otherwise reports a real
 * product as missing.
 *
 * This is deliberately limited to punctuation and invisible spacing: it never
 * changes letters or digits, and it is only used for lookup, never for storage.
 */
const LOOKUP_DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
const LOOKUP_SPACES = /[\u00a0\u2007\u202f]/g;
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;

export function normaliseLookupText(value: unknown): string {
  return String(value ?? '')
    .replace(LOOKUP_DASHES, '-')
    .replace(LOOKUP_SPACES, ' ')
    .replace(ZERO_WIDTH, '')
    .trim();
}
