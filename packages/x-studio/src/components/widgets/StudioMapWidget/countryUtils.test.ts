import { describe, expect, it } from 'vitest';
import {
  normalizeToAlpha2,
  normalizeToStateAbbr,
  alpha2ToName,
  NUMERIC_TO_ALPHA2,
  FIPS_TO_STATE_ABBR,
  STATE_ABBR_TO_NAME,
  EUROPEAN_ALPHA2_CODES,
} from './countryUtils';

// ─── normalizeToAlpha2 ─────────────────────────────────────────────────────

describe('normalizeToAlpha2', () => {
  it('resolves full country names case-insensitively', () => {
    expect(normalizeToAlpha2('Germany')).toBe('DE');
    expect(normalizeToAlpha2('germany')).toBe('DE');
    expect(normalizeToAlpha2('GERMANY')).toBe('DE');
  });

  it('resolves common aliases ahead of the alpha-2 shortcut', () => {
    expect(normalizeToAlpha2('UK')).toBe('GB');
    expect(normalizeToAlpha2('America')).toBe('US');
    expect(normalizeToAlpha2('USA')).toBe('US');
    expect(normalizeToAlpha2('us')).toBe('US');
    expect(normalizeToAlpha2('Burma')).toBe('MM');
  });

  it('resolves aliases with alternate spellings/apostrophes', () => {
    expect(normalizeToAlpha2('Ivory Coast')).toBe('CI');
    expect(normalizeToAlpha2("Cote d'Ivoire")).toBe('CI');
    expect(normalizeToAlpha2('Czechia')).toBe('CZ');
    expect(normalizeToAlpha2('Czech Republic')).toBe('CZ');
  });

  it('resolves multi-word country names', () => {
    expect(normalizeToAlpha2('United Arab Emirates')).toBe('AE');
    expect(normalizeToAlpha2('New Zealand')).toBe('NZ');
    expect(normalizeToAlpha2('South Korea')).toBe('KR');
  });

  it('passes through valid-looking alpha-2 codes verbatim (upper-cased)', () => {
    expect(normalizeToAlpha2('US')).toBe('US');
    expect(normalizeToAlpha2('gb')).toBe('GB');
  });

  it('does not validate the 2-letter shortcut against a known-country list', () => {
    // Unlike normalizeToStateAbbr, any 2 ASCII letters pass through untouched.
    expect(normalizeToAlpha2('zz')).toBe('ZZ');
  });

  it('resolves recognized alpha-3 codes', () => {
    expect(normalizeToAlpha2('USA')).toBe('US');
    expect(normalizeToAlpha2('DEU')).toBe('DE');
    expect(normalizeToAlpha2('GBR')).toBe('GB');
  });

  it('returns null for unrecognized alpha-3 codes', () => {
    expect(normalizeToAlpha2('ZZZ')).toBeNull();
  });

  it('returns null for invalid or unmatched input', () => {
    expect(normalizeToAlpha2('')).toBeNull();
    expect(normalizeToAlpha2('   ')).toBeNull();
    expect(normalizeToAlpha2('Narnia')).toBeNull();
    expect(normalizeToAlpha2(840)).toBeNull();
    expect(normalizeToAlpha2(null)).toBeNull();
    expect(normalizeToAlpha2(undefined)).toBeNull();
    expect(normalizeToAlpha2({})).toBeNull();
    expect(normalizeToAlpha2(['US'])).toBeNull();
  });

  it('trims surrounding whitespace before matching', () => {
    expect(normalizeToAlpha2(' Germany ')).toBe('DE');
  });
});

// ─── normalizeToStateAbbr ──────────────────────────────────────────────────

describe('normalizeToStateAbbr', () => {
  it('resolves 2-letter abbreviations case-insensitively', () => {
    expect(normalizeToStateAbbr('CA')).toBe('CA');
    expect(normalizeToStateAbbr('ca')).toBe('CA');
  });

  it('resolves full state names case-insensitively', () => {
    expect(normalizeToStateAbbr('California')).toBe('CA');
    expect(normalizeToStateAbbr('california')).toBe('CA');
    expect(normalizeToStateAbbr('New York')).toBe('NY');
    expect(normalizeToStateAbbr('District of Columbia')).toBe('DC');
  });

  it('resolves numeric FIPS codes', () => {
    expect(normalizeToStateAbbr(6)).toBe('CA');
    expect(normalizeToStateAbbr(36)).toBe('NY');
  });

  it('resolves FIPS codes given as strings, padded or not', () => {
    expect(normalizeToStateAbbr('06')).toBe('CA');
    expect(normalizeToStateAbbr('6')).toBe('CA');
  });

  it('rejects a 2-letter code that is not a known state abbreviation', () => {
    // Contrast with normalizeToAlpha2, which permissively passes through any
    // 2 ASCII letters — normalizeToStateAbbr validates against FIPS_TO_STATE_ABBR.
    expect(normalizeToStateAbbr('ZZ')).toBeNull();
  });

  it('returns null for null/undefined/non-string-non-number input', () => {
    expect(normalizeToStateAbbr(null)).toBeNull();
    expect(normalizeToStateAbbr(undefined)).toBeNull();
    expect(normalizeToStateAbbr({})).toBeNull();
    expect(normalizeToStateAbbr(['CA'])).toBeNull();
  });

  it('returns null for empty or whitespace-only strings', () => {
    expect(normalizeToStateAbbr('')).toBeNull();
    expect(normalizeToStateAbbr('   ')).toBeNull();
  });
});

// ─── alpha2ToName ───────────────────────────────────────────────────────────

describe('alpha2ToName', () => {
  it('returns a real English display name distinct from the raw code', () => {
    const us = alpha2ToName('US');
    expect(us).toBe('United States');
    expect(us).not.toBe('US');
    expect(us.length).toBeGreaterThan(2);

    const fr = alpha2ToName('FR');
    expect(fr).toBe('France');
    expect(fr).not.toBe('FR');
  });
});

// ─── EUROPEAN_ALPHA2_CODES ─────────────────────────────────────────────────

describe('EUROPEAN_ALPHA2_CODES', () => {
  it('includes expected European members', () => {
    expect(EUROPEAN_ALPHA2_CODES.has('FR')).toBe(true);
    expect(EUROPEAN_ALPHA2_CODES.has('DE')).toBe(true);
    expect(EUROPEAN_ALPHA2_CODES.has('RU')).toBe(true);
    expect(EUROPEAN_ALPHA2_CODES.has('GE')).toBe(true);
    expect(EUROPEAN_ALPHA2_CODES.has('CY')).toBe(true);
    expect(EUROPEAN_ALPHA2_CODES.has('XK')).toBe(true);
    expect(EUROPEAN_ALPHA2_CODES.has('VA')).toBe(true);
  });

  it('excludes clearly non-European codes', () => {
    expect(EUROPEAN_ALPHA2_CODES.has('US')).toBe(false);
    expect(EUROPEAN_ALPHA2_CODES.has('JP')).toBe(false);
    expect(EUROPEAN_ALPHA2_CODES.has('CN')).toBe(false);
    expect(EUROPEAN_ALPHA2_CODES.has('BR')).toBe(false);
  });
});

// ─── Data table spot-checks ─────────────────────────────────────────────────

describe('NUMERIC_TO_ALPHA2', () => {
  it('maps ISO numeric codes to alpha-2', () => {
    expect(NUMERIC_TO_ALPHA2[840]).toBe('US');
    expect(NUMERIC_TO_ALPHA2[826]).toBe('GB');
    expect(NUMERIC_TO_ALPHA2[10]).toBe('AQ');
  });
});

describe('FIPS_TO_STATE_ABBR', () => {
  it('maps zero-padded FIPS codes to state abbreviations', () => {
    expect(FIPS_TO_STATE_ABBR['06']).toBe('CA');
    expect(FIPS_TO_STATE_ABBR['36']).toBe('NY');
    expect(FIPS_TO_STATE_ABBR['11']).toBe('DC');
  });
});

describe('STATE_ABBR_TO_NAME', () => {
  it('maps state abbreviations to full display names', () => {
    expect(STATE_ABBR_TO_NAME.CA).toBe('California');
    expect(STATE_ABBR_TO_NAME.DC).toBe('District of Columbia');
    expect(STATE_ABBR_TO_NAME.NY).toBe('New York');
  });
});
