/**
 * ISO 4217 active tender codes accepted by the product form.
 *
 * The server validates the same set in `server/src/constants/currencies.ts`.
 * The client copy exists so the form can reject a typo before a round trip and
 * offer a picker; the server remains the source of truth. Keep the two arrays
 * identical (a regression test compares them).
 */
export const PRODUCT_CURRENCY_CODES = Object.freeze([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP',
  'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD',
  'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR',
  'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF',
  'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL',
  'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR',
  'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR',
  'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR',
  'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD',
  'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB',
  'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX',
  'USD', 'UYU', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD',
  'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWG',
]);

/** English display names used only by the picker; the code remains the stored value. */
const CURRENCY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  AED: "United Arab Emirates Dirham",  AFN: "Afghan Afghani",  ALL: "Albanian Lek",  AMD: "Armenian Dram",
  ANG: "Netherlands Antillean Guilder",  AOA: "Angolan Kwanza",  ARS: "Argentine Peso",  AUD: "Australian Dollar",
  AWG: "Aruban Florin",  AZN: "Azerbaijani Manat",  BAM: "Bosnia-Herzegovina Convertible Mark",  BBD: "Barbadian Dollar",
  BDT: "Bangladeshi Taka",  BGN: "Bulgarian Lev",  BHD: "Bahraini Dinar",  BIF: "Burundian Franc",  BMD: "Bermudan Dollar",
  BND: "Brunei Dollar",  BOB: "Bolivian Boliviano",  BRL: "Brazilian Real",  BSD: "Bahamian Dollar",  BTN: "Bhutanese Ngultrum",
  BWP: "Botswanan Pula",  BYN: "Belarusian Ruble",  BZD: "Belize Dollar",  CAD: "Canadian Dollar",  CDF: "Congolese Franc",
  CHF: "Swiss Franc",  CLP: "Chilean Peso",  CNY: "Chinese Yuan",  COP: "Colombian Peso",  CRC: "Costa Rican Colón",
  CUP: "Cuban Peso",  CVE: "Cape Verdean Escudo",  CZK: "Czech Koruna",  DJF: "Djiboutian Franc",  DKK: "Danish Krone",
  DOP: "Dominican Peso",  DZD: "Algerian Dinar",  EGP: "Egyptian Pound",  ERN: "Eritrean Nakfa",  ETB: "Ethiopian Birr",
  EUR: "Euro",  FJD: "Fijian Dollar",  FKP: "Falkland Islands Pound",  GBP: "British Pound",  GEL: "Georgian Lari",
  GHS: "Ghanaian Cedi",  GIP: "Gibraltar Pound",  GMD: "Gambian Dalasi",  GNF: "Guinean Franc",  GTQ: "Guatemalan Quetzal",
  GYD: "Guyanaese Dollar",  HKD: "Hong Kong Dollar",  HNL: "Honduran Lempira",  HTG: "Haitian Gourde",
  HUF: "Hungarian Forint",  IDR: "Indonesian Rupiah",  ILS: "Israeli New Shekel",  INR: "Indian Rupee",
  IQD: "Iraqi Dinar",  IRR: "Iranian Rial",  ISK: "Icelandic Króna",  JMD: "Jamaican Dollar",  JOD: "Jordanian Dinar",
  JPY: "Japanese Yen",  KES: "Kenyan Shilling",  KGS: "Kyrgyz Som",  KHR: "Cambodian Riel",  KMF: "Comorian Franc",
  KPW: "North Korean Won",  KRW: "South Korean Won",  KWD: "Kuwaiti Dinar",  KYD: "Cayman Islands Dollar",
  KZT: "Kazakhstani Tenge",  LAK: "Laotian Kip",  LBP: "Lebanese Pound",  LKR: "Sri Lankan Rupee",  LRD: "Liberian Dollar",
  LSL: "Lesotho Loti",  LYD: "Libyan Dinar",  MAD: "Moroccan Dirham",  MDL: "Moldovan Leu",  MGA: "Malagasy Ariary",
  MKD: "Macedonian Denar",  MMK: "Myanmar Kyat",  MNT: "Mongolian Tugrik",  MOP: "Macanese Pataca",  MRU: "Mauritanian Ouguiya",
  MUR: "Mauritian Rupee",  MVR: "Maldivian Rufiyaa",  MWK: "Malawian Kwacha",  MXN: "Mexican Peso",  MYR: "Malaysian Ringgit",
  MZN: "Mozambican Metical",  NAD: "Namibian Dollar",  NGN: "Nigerian Naira",  NIO: "Nicaraguan Córdoba",
  NOK: "Norwegian Krone",  NPR: "Nepalese Rupee",  NZD: "New Zealand Dollar",  OMR: "Omani Rial",  PAB: "Panamanian Balboa",
  PEN: "Peruvian Sol",  PGK: "Papua New Guinean Kina",  PHP: "Philippine Peso",  PKR: "Pakistani Rupee",
  PLN: "Polish Zloty",  PYG: "Paraguayan Guarani",  QAR: "Qatari Riyal",  RON: "Romanian Leu",  RSD: "Serbian Dinar",
  RUB: "Russian Ruble",  RWF: "Rwandan Franc",  SAR: "Saudi Riyal",  SBD: "Solomon Islands Dollar",  SCR: "Seychellois Rupee",
  SDG: "Sudanese Pound",  SEK: "Swedish Krona",  SGD: "Singapore Dollar",  SHP: "St. Helena Pound",  SLE: "Sierra Leonean Leone",
  SOS: "Somali Shilling",  SRD: "Surinamese Dollar",  SSP: "South Sudanese Pound",  STN: "São Tomé & Príncipe Dobra",
  SVC: "Salvadoran Colón",  SYP: "Syrian Pound",  SZL: "Swazi Lilangeni",  THB: "Thai Baht",  TJS: "Tajikistani Somoni",
  TMT: "Turkmenistani Manat",  TND: "Tunisian Dinar",  TOP: "Tongan Paʻanga",  TRY: "Turkish Lira",  TTD: "Trinidad & Tobago Dollar",
  TWD: "New Taiwan Dollar",  TZS: "Tanzanian Shilling",  UAH: "Ukrainian Hryvnia",  UGX: "Ugandan Shilling",
  USD: "US Dollar",  UYU: "Uruguayan Peso",  UZS: "Uzbekistani Som",  VED: "Bolívar Soberano",  VES: "Venezuelan Bolívar",
  VND: "Vietnamese Dong",  VUV: "Vanuatu Vatu",  WST: "Samoan Tala",  XAF: "Central African CFA Franc",
  XCD: "East Caribbean Dollar",  XOF: "West African CFA Franc",  XPF: "CFP Franc",  YER: "Yemeni Rial",
  ZAR: "South African Rand",  ZMW: "Zambian Kwacha",  ZWG: "Zimbabwean Gold",
});

export interface ProductCurrency {
  code: string;
  name: string;
}

/** The codes paired with their English names for the product-form picker. */
export const PRODUCT_CURRENCIES: readonly ProductCurrency[] = Object.freeze(
  PRODUCT_CURRENCY_CODES.map((code) => ({ code, name: CURRENCY_NAMES[code] ?? code })),
);

const PRODUCT_CURRENCY_SET = new Set<string>(PRODUCT_CURRENCY_CODES);

/** True for an active ISO 4217 tender code accepted by the API. */
export function isProductCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && PRODUCT_CURRENCY_SET.has(value.trim().toUpperCase());
}

/** Trim and upper-case a valid code; null when it is not accepted. */
export function normaliseCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return PRODUCT_CURRENCY_SET.has(code) ? code : null;
}

export default { PRODUCT_CURRENCIES, PRODUCT_CURRENCY_CODES, isProductCurrencyCode, normaliseCurrencyCode };
