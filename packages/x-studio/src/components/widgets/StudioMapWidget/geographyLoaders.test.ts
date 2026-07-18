import { describe, expect, it } from 'vitest';
import { BUILT_IN_GEOGRAPHY_DEFINITIONS } from './geographyLoaders';

// Regression coverage for the tier-2 finding: the shipped `world-atlas` 110m topology gives
// exactly 3 features a `null`/`undefined` `id` (identifiable only by `properties.name`) —
// Kosovo, Northern Cyprus ("N. Cyprus"), and Somaliland — which used to be silently dropped
// by the `!alpha2` check in `loadWorldGeography`/`loadEuropeGeography` because
// `NUMERIC_TO_ALPHA2[NaN]` never resolves. Kosovo now survives via the same "XK" de facto code
// this codebase already treats as canonical elsewhere (`countryUtils.ts`'s `NAME_TO_ALPHA2`,
// `ALPHA3_TO_ALPHA2`, and `EUROPEAN_ALPHA2_CODES`). Northern Cyprus and Somaliland have no
// comparably established alpha-2 code, so they remain (documented, not silently) excluded.
describe('loadWorldGeography', () => {
  it('keeps the Kosovo feature under the "XK" id', async () => {
    const fc = await BUILT_IN_GEOGRAPHY_DEFINITIONS.world.loader();
    const kosovo = fc.features.find((f) => f.properties?.name === 'XK' && f.id === 'XK');
    expect(kosovo).toBeTruthy();
  });

  it('does not include Antarctica', async () => {
    const fc = await BUILT_IN_GEOGRAPHY_DEFINITIONS.world.loader();
    const antarctica = fc.features.find((f) => f.id === 'AQ');
    expect(antarctica).toBeUndefined();
  });

  it('still excludes Northern Cyprus and Somaliland (no established de facto alpha-2 code)', async () => {
    const fc = await BUILT_IN_GEOGRAPHY_DEFINITIONS.world.loader();
    const names = fc.features.map((f) => f.properties?.name);
    expect(names).not.toContain('N. Cyprus');
    expect(names).not.toContain('Somaliland');
  });

  it('resolves every feature to a 2-letter alpha-2 id', async () => {
    const fc = await BUILT_IN_GEOGRAPHY_DEFINITIONS.world.loader();
    expect(fc.features.length).toBeGreaterThan(150);
    fc.features.forEach((f) => {
      expect(typeof f.id).toBe('string');
      expect(f.id as string).toMatch(/^[A-Z]{2}$/);
    });
  });
});

describe('loadEuropeGeography', () => {
  it('includes Kosovo in the Europe subset', async () => {
    const fc = await BUILT_IN_GEOGRAPHY_DEFINITIONS.europe.loader();
    expect(fc.features.some((f) => f.id === 'XK')).toBe(true);
  });
});
