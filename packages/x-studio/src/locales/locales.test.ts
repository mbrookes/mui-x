/**
 * Locale completeness tests — verify that each non-English locale bundle
 * defines every key that exists in `DEFAULT_STUDIO_LOCALE_TEXT`.
 *
 * This used to compare fr/de/es against the ptBR bundle as a stand-in
 * "known-complete" reference instead of the actual default. That missed an
 * entire class of regressions: ptBR itself was quietly missing 97 keys that
 * existed on `DEFAULT_STUDIO_LOCALE_TEXT` (a coherent, feature-shaped set —
 * funnel/Sankey chart setup labels, calendar-year/quarter date-range presets,
 * cross-filter-bar mode labels, a dozen-plus accessibility strings, and KPI
 * trend labels), and because every non-English bundle was missing the exact
 * same 97 keys, comparing them against each other never caught it (see
 * architecture-review finding 3.1). Comparing directly against the default
 * text's key set is the only check that can catch "all locales are missing
 * the same key."
 */
import { describe, it, expect } from 'vitest';
import { ptBRLocaleText } from './ptBR';
import { frLocaleText } from './fr';
import { deLocaleText } from './de';
import { esLocaleText } from './es';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../internals/StudioUIConfigContext';

const DEFAULT_KEYS = Object.keys(DEFAULT_STUDIO_LOCALE_TEXT) as Array<
  keyof typeof DEFAULT_STUDIO_LOCALE_TEXT
>;

const BUNDLES: Array<{ name: string; locale: Partial<typeof DEFAULT_STUDIO_LOCALE_TEXT> }> = [
  { name: 'fr', locale: frLocaleText },
  { name: 'de', locale: deLocaleText },
  { name: 'es', locale: esLocaleText },
  { name: 'ptBR', locale: ptBRLocaleText },
];

describe('locale completeness', () => {
  it.each(BUNDLES)(
    '$name defines every key present in DEFAULT_STUDIO_LOCALE_TEXT',
    ({ name, locale }) => {
      const missing = DEFAULT_KEYS.filter((key) => !(key in locale));
      expect(
        missing,
        `${name} is missing ${missing.length} key(s) relative to the default locale text: ${missing.join(', ')}`,
      ).toHaveLength(0);
    },
  );

  it.each(BUNDLES)('$name has no empty string values', ({ name, locale }) => {
    const empty = Object.entries(locale)
      .filter(([, v]) => typeof v === 'string' && v.trim() === '')
      .map(([k]) => k);
    expect(empty, `${name} has empty string values for: ${empty.join(', ')}`).toHaveLength(0);
  });

  it.each(BUNDLES)('$name has no undefined/null values', ({ name, locale }) => {
    const nullish = Object.entries(locale)
      .filter(([, v]) => v == null)
      .map(([k]) => k);
    expect(nullish, `${name} has null/undefined values for: ${nullish.join(', ')}`).toHaveLength(0);
  });
});

/**
 * The KPI trend-window block ("Trend window", "From date filter", "Last 30 days", …) was
 * byte-identical English in ALL FOUR bundles — five keys, one coherent feature, appended to
 * `DEFAULT_STUDIO_LOCALE_TEXT` after the translation pass and copied verbatim into every
 * translation. Four independent translators do not all leave "Last 30 days" in English.
 *
 * The completeness test above cannot catch this: the keys were present in every bundle, just
 * untranslated. This guards the general shape — a non-English bundle whose value for a key is
 * character-for-character the English default is either an oversight or a deliberate
 * loanword, and the latter has to be declared.
 */
describe('locale translation coverage', () => {
  /**
   * Keys whose value legitimately matches English in a given bundle. Each entry is a real
   * loanword, an invariant abbreviation, or a proper noun — not an untranslated string.
   */
  const ALLOWED_ENGLISH: Record<string, Set<string>> = {
    // "Modulo" is the mathematical term in French and German too, and the "(%)" operator
    // symbol is invariant — es/ptBR accent it ("Módulo") purely because Spanish/Portuguese
    // orthography requires the accent, not because the word differs.
    fr: new Set(['exprOpModulo']),
    de: new Set(['exprOpModulo']),
    es: new Set<string>(),
    ptBR: new Set<string>(),
  };

  it.each(BUNDLES)('$name does not leave the KPI trend-window block in English', ({ locale }) => {
    const windowKeys = [
      'kpiSetupFixedWindowLabel',
      'kpiSetupFixedWindowNone',
      'kpiSetupFixedWindowMonth',
      'kpiSetupFixedWindowQuarter',
      'kpiSetupFixedWindowYear',
    ] as const;
    const untranslated = windowKeys.filter(
      (key) => locale[key] === DEFAULT_STUDIO_LOCALE_TEXT[key],
    );
    expect(
      untranslated,
      `left in English: ${untranslated.map((k) => `${k}="${DEFAULT_STUDIO_LOCALE_TEXT[k]}"`).join(', ')}`,
    ).toHaveLength(0);
  });

  it.each(BUNDLES)(
    '$name translates every multi-word English default it defines',
    ({ name, locale }) => {
      const allowed = ALLOWED_ENGLISH[name] ?? new Set<string>();
      const identical = Object.entries(locale)
        .filter(([key, value]) => {
          if (typeof value !== 'string' || allowed.has(key)) {
            return false;
          }
          const english =
            DEFAULT_STUDIO_LOCALE_TEXT[key as keyof typeof DEFAULT_STUDIO_LOCALE_TEXT];
          // Single words are frequently identical across languages by coincidence
          // ("Total", "Min.", "Max."); a multi-word English sentence is not.
          return typeof english === 'string' && english === value && /\s/.test(english.trim());
        })
        .map(([key]) => key);
      expect(
        identical,
        `${name} leaves ${identical.length} multi-word default(s) in English: ${identical.join(', ')}`,
      ).toHaveLength(0);
    },
  );
});
