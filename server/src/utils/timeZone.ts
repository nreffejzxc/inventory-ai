/**
 * The member's clock, for the one reader that cannot infer it: the AI model.
 *
 * WHY THIS EXISTS. Every timestamp Inventory AI stores is an instant, and every
 * instant the API returns is ISO UTC. That is correct for storage and for the
 * apps, which format it on the device — but the assistant has no device. It was
 * told `Today is <UTC date>` and handed raw ISO timestamps, so a member in
 * Manila asking "what moved today?" at 07:00 local time was answered for the
 * previous UTC day, and every quoted time was eight hours off. The fix is not a
 * timezone-aware database: it is a per-turn zone, validated here, used to render
 * the dates the model reads.
 *
 * The zone is a CLIENT HINT, never authorization: an unknown or malformed value
 * falls back to UTC rather than failing a turn, and an older client that sends
 * nothing keeps the exact behaviour it had before.
 */

const FALLBACK_TIME_ZONE = 'UTC';
const MAX_TIME_ZONE_LENGTH = 64;

/**
 * A usable IANA zone from whatever the client sent, or UTC.
 *
 * `Intl.DateTimeFormat` is the validator — there is no maintained list of zones
 * to drift from, and it throws `RangeError` for a name it cannot resolve. Input
 * is length-capped first so a large body cannot reach the formatter.
 */
export function resolveTimeZone(value: unknown): string {
  if (typeof value !== 'string') return FALLBACK_TIME_ZONE;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_TIME_ZONE_LENGTH) return FALLBACK_TIME_ZONE;
  try {
    // Constructing the formatter is the check; formatting a fixed instant makes
    // the check independent of when the turn runs.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

function parts(instant: Date, timeZone: string, options: Intl.DateTimeFormatOptions): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of new Intl.DateTimeFormat('en-US', { ...options, timeZone }).formatToParts(instant)) {
    if (part.type !== 'literal') out.set(part.type, part.value);
  }
  return out;
}

/** The calendar date in `timeZone`, as `YYYY-MM-DD`. */
export function localDate(instant: Date, timeZone: string): string {
  const p = parts(instant, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.get('year')}-${p.get('month')}-${p.get('day')}`;
}

/** The wall-clock time in `timeZone`, as 24-hour `HH:mm`. */
export function localTime(instant: Date, timeZone: string): string {
  const p = parts(instant, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.get('hour')}:${p.get('minute')}`;
}

/** Date and time in `timeZone`, as `YYYY-MM-DD HH:mm` — what the model quotes. */
export function localDateTime(instant: Date, timeZone: string): string {
  return `${localDate(instant, timeZone)} ${localTime(instant, timeZone)}`;
}

/**
 * The zone's offset at `instant`, as `GMT+09:00`.
 *
 * Stated in the prompt so the model can bound a local day itself when the member
 * says "today": the history tool's `from`/`to` take instants, and the offset is
 * the one fact needed to turn a local boundary into one.
 */
export function utcOffsetLabel(instant: Date, timeZone: string): string {
  const zone = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant)
    .find((p) => p.type === 'timeZoneName')?.value;
  // `longOffset` renders UTC as the bare word "GMT"; state the zero offset
  // explicitly so the prompt never reads "UTC (GMT)" as two different things.
  return !zone || zone === 'GMT' ? 'GMT+00:00' : zone;
}
