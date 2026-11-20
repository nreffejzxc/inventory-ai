/**
 * Small pure formatting helpers (dates, numbers, money). No i18n dependency —
 * manual, locale-independent output keeps behaviour identical on every device.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** Integer part with thousands separators; decimal part preserved when present. */
export function formatNumber(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const [int, dec] = String(num).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec !== undefined ? `${grouped}.${dec}` : grouped;
}

/** Number with up to 2 fixed decimals, thousands grouped, no currency symbol. */
export function formatMoney(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  const [int, decRaw] = abs.toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}.${decRaw}`;
}

/** "PHP 6,990.00" when a code is recorded; the bare amount when it is not. */
export function formatMoneyWithCurrency(value: unknown, currency: unknown): string {
  const amount = formatMoney(value);
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  return code ? `${code} ${amount}` : amount;
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface DateParts {
  year: number;
  month: string;
  day: number;
  hours: string;
  minutes: string;
}

function dateToParts(d: Date): DateParts {
  return {
    year: d.getFullYear(),
    month: MONTHS[d.getMonth()],
    day: d.getDate(),
    hours: pad(d.getHours()),
    minutes: pad(d.getMinutes()),
  };
}

/** e.g. "Sep 8, 2026". Invalid/absent input -> ''. */
export function formatDate(value: unknown): string {
  const d = parseDate(value);
  if (!d) return '';
  const p = dateToParts(d);
  return `${p.month} ${p.day}, ${p.year}`;
}

/** e.g. "Sep 8, 2026 · 14:05". Invalid/absent input -> ''. */
export function formatDateTime(value: unknown): string {
  const d = parseDate(value);
  if (!d) return '';
  const p = dateToParts(d);
  return `${p.month} ${p.day}, ${p.year} · ${p.hours}:${p.minutes}`;
}

/** Compact time-of-day, e.g. "14:05". Invalid/absent -> ''. */
export function formatTime(value: unknown): string {
  const d = parseDate(value);
  if (!d) return '';
  const p = dateToParts(d);
  return `${p.hours}:${p.minutes}`;
}

/**
 * A message-footer clock time, e.g. "2:05 PM". Invalid/absent -> ''.
 *
 * WHY 12-HOUR, AND WHY ONLY HERE. The chat bubble used to print `formatTime` — a bare
 * "14:05" in the bottom corner of every reply — and the owner read it as a metric and
 * asked whether it was a response time, which is the defect: a four-digit number beside
 * an answer has no stated meaning. "2:05 PM" cannot be read as a duration, and the bubble
 * labels it ("Sent" / "Answered") so nothing is left to infer. It is deliberately not
 * applied to the history and audit rows, which pair a time with a date ("Aug 8, 2026 ·
 * 14:05") and therefore have the meaning the chat footer was missing.
 */
export function formatClock12(value: unknown): string {
  const d = parseDate(value);
  if (!d) return '';
  const hours24 = d.getHours();
  const suffix = hours24 < 12 ? 'AM' : 'PM';
  const hour12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hour12}:${pad(d.getMinutes())} ${suffix}`;
}

/** Days since a date, used for relative labels like "2d ago" / "today". */
export function daysAgo(value: unknown): string {
  const d = parseDate(value);
  if (!d) return '';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // Unary `+` coerces to epoch millis; subtracting the two Dates directly is a
  // TS2362/TS2363 arithmetic error even though it is legal at runtime.
  const diff = Math.round((+startToday - +startThat) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  return `${diff}d ago`;
}

export default { formatNumber, formatMoney, formatDate, formatDateTime, formatTime, daysAgo };
