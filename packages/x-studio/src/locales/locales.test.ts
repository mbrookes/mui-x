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
