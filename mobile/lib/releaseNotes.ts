/**
 * Release notes — what the app tells its own users has changed.
 *
 * WHY THIS LIST LIVES IN THE BUNDLE AND NOT IN A DATABASE. A note is only useful beside the
 * screen that shows it, and it must be readable with no network at all. Keeping it here means
 * the note and the code it describes ship together, there is no new route, permission,
 * collection or secret to secure, and the screen renders offline. The cost is stated plainly:
 * editing the wording needs a publish, not a dashboard edit — see the recipe below.
 *
 * HOW TO WRITE AN ANNOUNCEMENT (the same recipe is in docs/guides/7-over-the-air-updates.md §7A):
 *   1. Add one entry to the TOP of `RELEASE_NOTES`, with a `date` of today.
 *   2. Give it an `id` that has never been used — the year, month, day and a short slug is
 *      enough. The id is the only thing that decides whether the card on the dashboard shows,
 *      so a reused id silently announces nothing.
 *   3. Publish: `npx eas-cli update --channel production --environment production --platform
 *      android -m "Release notes: <title>"`. The card appears on the dashboard after the phone
 *      has launched the new bundle once, and never returns once dismissed.
 *
 * Nothing here is a security control and nothing here is user data: the list is public product
 * news, and the only stored state is "this device acknowledged note <id>".
 */

/** What kind of change a note describes — shown as a pill on the What's New screen. */
export type ReleaseNoteKind = 'feature' | 'improvement' | 'fix';

export interface ReleaseNote {
  /** Stable, never reused. The dashboard card is keyed on this. */
  id: string;
  /** Display date, `YYYY-MM-DD`. See {@link formatReleaseDate} for why it is not a Date. */
  date: string;
  kind: ReleaseNoteKind;
  /** One short line — the card's heading and the screen's heading for this note. */
  title: string;
  /** One or two sentences of plain English. */
  summary: string;
  /** Optional detail bullets. Kept short: this is news, not documentation. */
  points?: readonly string[];
}

/**
 * Newest first. `RELEASE_NOTES[0]` is the note the dashboard card announces.
 *
 * Written for the person using the app, not for a changelog reader: no internal phase numbers,
 * no file names, no acronyms, no exclamation marks.
 */
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    id: '2026-11-03-catalogue-overview',
    date: '2026-11-03',
    kind: 'feature',
    title: 'See what your catalogue contains',
    summary: 'Ask for a quick picture of your active products, categories, and how much brand and description information is recorded.',
    points: [
      'The answer can show product counts by category and how many brands are on file.',
      'Brand comparisons use recorded descriptions and price ranges, not guesses.',
      'Stock is still checked separately; a product count is not a quality rating.',
    ],
  },
  {
    id: '2026-11-03-natural-product-questions',
    date: '2026-11-03',
    kind: 'feature',
    title: 'Ask for products the way you would ask a manager',
    summary: 'Describe the job or kind of product and let Inventory AI find the matching items in your catalogue.',
    points: [
      'You do not need the exact product name; it searches names, recorded brands, and descriptions.',
      'It shows what is available and says plainly when nothing matches.',
      'It will not invent a brand or call something best without recorded evidence.',
    ],
  },
  {
    id: '2026-11-03-product-brands',
    date: '2026-11-03',
    kind: 'improvement',
    title: 'Record the brand on a product',
    summary: 'Add the brand when you create or edit a product so it can be found and compared accurately.',
    points: [
      'Brand is optional and appears on the product detail screen.',
      'Search and the assistant can use a recorded brand when you ask for it.',
      'If no brand is recorded, the app says so instead of guessing.',
    ],
  },
  {
    id: '2026-10-25-whats-new',
    date: '2026-10-25',
    kind: 'feature',
    title: 'A place to see what has changed',
    summary: 'Inventory AI can now show you what is new, without you updating anything from the store.',
    points: [
      'This screen lists every change, newest first.',
      'Anything worth knowing about also appears once as a card on your dashboard.',
      'Small wording and layout fixes arrive quietly — they are not announced.',
    ],
  },
  {
    id: '2026-10-25-invitations',
    date: '2026-10-25',
    kind: 'feature',
    title: 'Invite your team by email',
    summary: 'Add a teammate without creating a password for them. They choose their own when they join.',
    points: [
      'Owners and admins can send an invitation from Users, then Invitations.',
      'The invitation opens in the app, where your teammate picks a password and joins your business.',
      'Every invitation can be cancelled before it is used.',
    ],
  },
  {
    id: '2026-10-24-legal-and-deletion',
    date: '2026-10-24',
    kind: 'improvement',
    title: 'Privacy, terms, and closing your account',
    summary: 'The privacy policy and terms of use are now readable from Profile, and an owner can close the account.',
    points: [
      'Profile links to the privacy policy and the terms of use.',
      'Closing the account is on Profile, below sign out, behind its own confirmation.',
      'Closing the account ends every session and removes the business and its records.',
    ],
  },
];

/** The note the dashboard card announces, or null when this bundle carries none. */
export const LATEST_RELEASE_NOTE: ReleaseNote | null = RELEASE_NOTES[0] ?? null;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-10-25` → `Oct 25, 2026`, without going through a `Date`.
 *
 * `new Date('2026-10-25')` parses as UTC midnight, so rendering it in a negative UTC offset
 * would print the previous day. A note's date is a calendar date, not an instant, so the string
 * is split instead. Anything that is not a real `YYYY-MM-DD` renders as an empty string rather
 * than "Invalid Date".
 */
export function formatReleaseDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}
