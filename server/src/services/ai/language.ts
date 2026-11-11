/**
 * AI-84 — detect the member's reply language from the latest message.
 *
 * The system prompt already names the language rule, but the 2026-11-06 control showed
 * that a long English tool transcript can still win: only 4 of 14 Bisaya/Tagalog replies
 * followed the question's language. This module gives the turn loop a second, direct
 * signal that is appended next to the answer instruction, where it is much harder for the
 * model to overlook than a rule buried in a long system prompt.
 *
 * WHY A WORD LIST RATHER THAN A MODEL CALL. This decision has to be deterministic, cheap
 * and testable, and it only chooses a language reminder — it never changes the facts, the
 * tools or the answer. Bisaya/Cebuano and Tagalog/Filipino share many function words, so
 * the lists deliberately contain distinctive words only and ambiguous English spellings
 * ("at", "may", "stock", "unit") are excluded. A miss leaves the request exactly as it was
 * before this module existed; a false positive only adds a reminder to reply in the
 * language the member actually used.
 */

export type ReplyLanguage = 'Bisaya' | 'Tagalog';

/**
 * Distinctly Bisaya/Cebuano words. Shared Tagalog words (`ang`, `mga`, `sa`, `ng`) are
 * omitted on purpose: they would classify almost every Philippine-language sentence as
 * both, and the point is to tell the two languages apart.
 */
const BISAYA_WORDS = new Set([
  'asa',
  'akong',
  'buhi',
  'diin',
  'dili',
  'gahapon',
  'ilang',
  'imong',
  'kaayo',
  'kana',
  'kanus-a',
  'karong',
  'kini',
  'kinsa',
  'mao',
  'naa',
  'nahurot',
  'nato',
  'nawala',
  'ngano',
  'nganong',
  'niini',
  'ninyo',
  'pag-ayo',
  'palihug',
  'pila',
  'sakyanan',
  'sulod',
  'tanan',
  'tua',
  'ubos',
  'ug',
  'unsa',
  'yunit',
]);

/** Distinctly Tagalog/Filipino words. Ambiguous English words are intentionally absent. */
const TAGALOG_WORDS = new Set([
  'aking',
  'aktibo',
  'ano',
  'bakit',
  'benta',
  'bodega',
  'buwan',
  'bumaba',
  'hanggang',
  'hindi',
  'ilan',
  'inyo',
  'ito',
  'iyan',
  'iyong',
  'kabuuang',
  'kahapon',
  'kailan',
  'kailangan',
  'kami',
  'kanila',
  'kategorya',
  'kayo',
  'kita',
  'lahat',
  'linggo',
  'lokasyon',
  'magkano',
  'mayroon',
  'meron',
  'mula',
  'nabenta',
  'namin',
  'napupunta',
  'nasaan',
  'natin',
  'natitira',
  'negosyo',
  'ngayon',
  'oo',
  'para',
  'pinakamababa',
  'pinakamataas',
  'presyo',
  'produkto',
  'pwede',
  'saan',
  'sila',
  'sino',
  'taon',
  'tindahan',
  'tumaas',
  'wala',
  'walang',
]);

/** Split on anything that cannot be part of a word, keeping `kanus-a` and `pag-ayo`. */
function wordsOf(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .match(/[a-zñ'-]+/g) ?? [];
}

/**
 * The member's language, or null when the message is English or the evidence is tied.
 *
 * A single distinctive Bisaya or Tagalog word is enough when the other list has no match:
 * "Pila?" and "Ilan?" are complete questions in their languages. A tie is deliberately
 * treated as unknown, because guessing the wrong Philippine language is the exact defect
 * AI-84 was opened for.
 */
export function replyLanguageOf(message: string): ReplyLanguage | null {
  let bisaya = 0;
  let tagalog = 0;
  for (const word of wordsOf(message)) {
    if (BISAYA_WORDS.has(word)) bisaya += 1;
    if (TAGALOG_WORDS.has(word)) tagalog += 1;
  }
  if (bisaya === tagalog) return null;
  return bisaya > tagalog ? 'Bisaya' : 'Tagalog';
}

/**
 * A direct instruction appended to the answer round (and to a simple-turn prompt).
 *
 * It repeats the facts-preservation rule on purpose: the reminder must not trade accuracy
 * for language. Product names, SKUs, codes, numbers, URLs and necessary technical terms
 * stay exactly as the tool returned them.
 */
export function languageDirective(message: string): string | null {
  const language = replyLanguageOf(message);
  if (!language) return null;
  const name = language === 'Bisaya' ? 'Bisaya/Cebuano' : 'Tagalog/Filipino';
  return (
    `LANGUAGE FOR THIS ANSWER: the member wrote in ${name}. Write the entire answer in ` +
    `${name}, using the same language as the question. Do not answer in English or in the ` +
    `other Philippine language. Keep product names, SKUs, codes, numbers, URLs and necessary ` +
    `technical terms exactly as recorded; do not translate them or invent anything.`
  );
}

export default { replyLanguageOf, languageDirective };
