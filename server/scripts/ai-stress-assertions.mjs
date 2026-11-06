// Assertion helpers for the live AI stress evaluators.
//
// A provider may format product names with Unicode spaces. Q16 returned
// "SteelSeries Arctis Nova\u202F7" (narrow no-break space), which is visually identical
// to a normal space but does not match an assertion written with an ASCII space.
// Normalise only the copy used for matching; the recorded answer stays verbatim.

/** Collapse every whitespace form to one ASCII space for comparison. */
export function normaliseStressText(value) {
  return String(value ?? '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The assertions that still do not match after whitespace normalisation. */
export function missingStressAssertions(answer, patterns) {
  const text = normaliseStressText(answer);
  return patterns.filter((pattern) => !pattern.test(text)).map((pattern) => String(pattern));
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A number with optional thousands separators, e.g. 6,290 or 6290. */
const NUMBER_WORDS = new Map([
  [0, 'zero'], [1, 'one'], [2, 'two'], [3, 'three'], [4, 'four'], [5, 'five'],
  [6, 'six'], [7, 'seven'], [8, 'eight'], [9, 'nine'], [10, 'ten'],
  [11, 'eleven'], [12, 'twelve'], [13, 'thirteen'], [14, 'fourteen'], [15, 'fifteen'],
  [16, 'sixteen'], [17, 'seventeen'], [18, 'eighteen'], [19, 'nineteen'], [20, 'twenty'],
  [30, 'thirty'], [40, 'forty'], [50, 'fifty'], [60, 'sixty'], [70, 'seventy'],
  [80, 'eighty'], [90, 'ninety'],
]);

function numberPattern(value) {
  const digits = String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s,]*');
  const word = NUMBER_WORDS.get(Number(value));
  return new RegExp(`\\b(?:${digits}${word ? `|${word}` : ''})\\b`, 'i');
}

function asPattern(value) {
  if (value instanceof RegExp) return value;
  if (typeof value === 'number') return numberPattern(value);
  return new RegExp(escapeRegExp(value), 'i');
}

function allMatches(text, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const matches = [];
  let match;
  while ((match = re.exec(text))) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return matches;
}

/**
 * A label and value must be close, with no other number or coordinating
 * conjunction between them. This is deliberately stricter than "same sentence":
 * "14 units and 136 products" must not satisfy "14 products".
 */
function labeledValue(part, label, value, { allowComma = false } = {}) {
  const labels = allMatches(part, label);
  const values = allMatches(part, value);
  for (const one of labels) {
    for (const other of values) {
      const [left, right] = one.start <= other.start ? [one, other] : [other, one];
      const between = part.slice(left.end, right.start);
      if (between.length > 64) continue;
      if (/\d/.test(between)) continue;
      // A comma that frames the label itself ("**Product**, worth PHP 2,499") is
      // punctuation, not a list separator. Drop only that leading comma so
      // "Product A, Product B, 2,499" still fails the proximity rule.
      const afterLabel = between.replace(/^[\s*_`]+/, '');
      const withoutLabelPunctuation = afterLabel.replace(/^[,;]\s*/, '');
      if (!allowComma && /[,;]/.test(withoutLabelPunctuation)) continue;
      if (/\b(?:and|but|while|whereas)\b/i.test(between)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Lines and sentences, with Unicode whitespace normalised but line breaks kept.
 * A labeled value must occur in the SAME segment as its label; this is what stops
 * "12 products" and "99 units" from passing when the answer swapped them.
 */
function segments(answer) {
  const out = [];
  for (const rawLine of String(answer ?? '').split(/\r?\n/)) {
    const line = rawLine
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/[^\S\r\n]+/g, ' ')
      .trim();
    if (!line) continue;
    out.push(line);
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const clean = sentence.trim();
      if (clean) out.push(clean);
    }
  }
  return out;
}

/**
 * Structured expectations:
 *   all:      every pattern/name must appear anywhere
 *   any:      at least one pattern/name must appear
 *   pairs:    label and value must appear in the same line or sentence
 *   lineAll:  every pattern in a group must appear on one line; used for table
 *             rows and bullet records where another column sits between them
 *   forbid:   none of these may appear
 *   evidence: a source URL or an explicit unavailable result is required
 *   toolsAny: at least one of these tools must have been used
 */
function missingExpectations(expect, answer, tools) {
  const text = normaliseStressText(answer);
  const parts = segments(answer);
  const problems = [];

  for (const pattern of expect.all ?? []) {
    if (!asPattern(pattern).test(text)) problems.push(`missing ${String(pattern)}`);
  }

  const any = expect.any ?? [];
  if (any.length > 0 && !any.some((pattern) => asPattern(pattern).test(text))) {
    problems.push(`missing any of ${any.map(String).join(' | ')}`);
  }

  for (const group of expect.lineAll ?? []) {
    const patterns = group.map(asPattern);
    if (!parts.some((part) => patterns.every((pattern) => pattern.test(part)))) {
      problems.push(`missing one line with ${group.map(String).join(' + ')}`);
    }
  }

  for (const pair of expect.pairs ?? []) {
    const label = asPattern(pair.label);
    const value = asPattern(pair.value);
    if (!parts.some((part) => labeledValue(part, label, value, pair))) {
      problems.push(`unlabeled ${String(pair.label)} / ${String(pair.value)}`);
    }
  }

  const pairSets = expect.pairSets ?? [];
  if (
    pairSets.length > 0 &&
    !pairSets.some((set) =>
      set.every((pair) => {
        const label = asPattern(pair.label);
        const value = asPattern(pair.value);
        return parts.some((part) => labeledValue(part, label, value, pair));
      }),
    )
  ) {
    problems.push('missing one complete labeled set (aggregate count or every product count)');
  }

  for (const pattern of expect.forbid ?? []) {
    if (asPattern(pattern).test(text)) problems.push(`forbidden ${String(pattern)}`);
  }

  if (expect.evidence) {
    const hasSource = /https?:\/\//i.test(text);
    const unavailable =
      /\b(?:unavailable|no (?:web )?sources?|no (?:owner )?reviews?|no review evidence|could not be retrieved|not available)\b/i.test(
        text,
      );
    if (!hasSource && !unavailable) {
      problems.push('missing source URL or explicit unavailable result');
    }
  }

  if (Array.isArray(expect.toolsAny) && expect.toolsAny.length > 0) {
    if (!expect.toolsAny.some((name) => tools.includes(name))) {
      problems.push(`missing evidence tool ${expect.toolsAny.join(' | ')}`);
    }
  }

  return problems;
}

/**
 * Score the answer itself, and report the expected tool route separately.
 *
 * A content-correct answer reached through a different read tool is still a correct
 * answer. Tool selection stays visible as `toolHit` (and a summary count) so route
 * drift can be measured without turning it into an answer failure. Questions that
 * require evidence (research and absence claims) opt into `expect.toolsAny`.
 */
export function assessStressResult(question, result) {
  const answer = String(result?.content ?? '');
  const tools = Array.isArray(result?.toolsUsed) ? result.toolsUsed : [];
  const expectedTools = Array.isArray(question?.tools) ? question.tools : [];
  const patterns = Array.isArray(question?.must) ? question.must : [];
  const missing = [
    ...missingStressAssertions(answer, patterns),
    ...missingExpectations(question?.expect ?? {}, answer, tools),
  ];
  const toolHit = expectedTools.length === 0 || expectedTools.some((name) => tools.includes(name));
  const failureNotice = /\[(?:ERROR|TOOL_|PRODUCT_NOT_FOUND)|Max turns exceeded/i.test(answer);
  const ok = answer.length > 0 && !result?.degraded && !failureNotice && missing.length === 0;
  return { ok, toolHit, missing, failureNotice };
}
