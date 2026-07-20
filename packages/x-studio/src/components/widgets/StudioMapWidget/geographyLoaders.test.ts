import { describe, expect, it, vi } from 'vitest';
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

// The built-in geography `label` (shown as the "Map type" selector option in the Setup
// panel) is pure UI chrome, not a data-derived proper noun — it should track the active
// locale rather than hardcode the English region name. `getRegionDisplayName` resolves it
// via `Intl.DisplayNames(undefined, { type: 'region' })`, mirroring the
// `Intl.DateTimeFormat(undefined, …)` pattern used for month names in `temporalUtils.ts`.
describe('BUILT_IN_GEOGRAPHY_DEFINITIONS labels', () => {
  it('matches the expected English region names under the default (English) test locale', () => {
    expect(BUILT_IN_GEOGRAPHY_DEFINITIONS.world.label).toBe('World');
    expect(BUILT_IN_GEOGRAPHY_DEFINITIONS.usa.label).toBe('United States');
    expect(BUILT_IN_GEOGRAPHY_DEFINITIONS.europe.label).toBe('Europe');
  });

  it('resolves labels through Intl.DisplayNames (locale-aware) rather than a hardcoded English literal', async () => {
    const OriginalDisplayNames = Intl.DisplayNames;
    const spy = vi.spyOn(Intl, 'DisplayNames').mockImplementation(
      // A regular `function` (not an arrow) so it can be invoked with `new` — the
      // production code calls `new Intl.DisplayNames(...)`, and a mock implementation
      // that isn't itself `new`-able throws "is not a constructor".
      function MockDisplayNames(_locales?: any, options?: any) {
        return new OriginalDisplayNames(['fr'], options);
      } as unknown as typeof Intl.DisplayNames,
    );
    try {
      vi.resetModules();
      const { BUILT_IN_GEOGRAPHY_DEFINITIONS: frDefs } = await import('./geographyLoaders');
      expect(frDefs.world.label).toBe('Monde');
      expect(frDefs.usa.label).toBe('États-Unis');
      expect(frDefs.europe.label).toBe('Europe');
    } finally {
      spy.mockRestore();
      vi.resetModules();
    }
  });
});
