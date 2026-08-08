import { describe, expect, it, afterEach } from 'vitest';
import { formatDateWithPreset } from './numberFormat';
import { setActiveStudioLocale } from './studioLocale';

/**
 * Per-column date presentation (AG_STUDIO_GAP_ANALYSIS XS-GRID-003).
 *
 * Presets rather than format strings, for two reasons that these tests pin: a preset LOCALIZES,
 * and a preset is a closed set so a doc-authored value cannot smuggle in a pattern.
 */

afterEach(() => {
  setActiveStudioLocale(undefined);
});

describe('formatDateWithPreset', () => {
  it('returns a bare date untouched under the iso preset', () => {
    // L1 already normalized it. Re-deriving through `Intl` would risk a timezone round-trip to
    // produce the string we started with.
    expect(formatDateWithPreset('2026-03-04', 'iso')).to.equal('2026-03-04');
  });

  it('does not day-shift a date-only value for a viewer west of UTC', () => {
    // A bare `YYYY-MM-DD` parses as UTC midnight, so a naive format renders the previous day for
    // anyone behind UTC. The formatter anchors date-only values to UTC — the same whole-day
    // convention L1 and the filter engine hold to. Asserted against the day NUMBER, so the test is
    // valid in whatever timezone CI happens to run in.
    setActiveStudioLocale('en-GB');
    expect(formatDateWithPreset('2026-03-04', 'short')).to.contain('4');
    expect(formatDateWithPreset('2026-03-04', 'short')).to.contain('2026');
    expect(formatDateWithPreset('2026-03-04', 'numeric')).to.contain('04');
  });

  it('renders month names in the active Studio locale', () => {
    // The reason presets exist rather than format strings: a French dashboard gets French months
    // without its author having chosen a French pattern.
    setActiveStudioLocale('fr-FR');
    expect(formatDateWithPreset('2026-03-04', 'long').toLowerCase()).to.contain('mars');
    setActiveStudioLocale('en-GB');
    expect(formatDateWithPreset('2026-03-04', 'long').toLowerCase()).to.contain('march');
  });

  it('distinguishes the presets', () => {
    setActiveStudioLocale('en-GB');
    const rendered = new Set(
      (['iso', 'numeric', 'short', 'long', 'monthYear', 'year'] as const).map((preset) =>
        formatDateWithPreset('2026-03-04', preset),
      ),
    );
    // Six presets that all rendered the same string would be six controls doing one thing.
    expect(rendered.size).to.equal(6);
  });

  it('drops the day for monthYear and year', () => {
    setActiveStudioLocale('en-GB');
    expect(formatDateWithPreset('2026-03-04', 'year')).to.equal('2026');
    expect(formatDateWithPreset('2026-03-04', 'monthYear')).to.not.contain('4');
  });

  it('returns an unparseable value as itself rather than "Invalid Date"', () => {
    // A cell showing its own raw content is debuggable; one showing `Invalid Date` tells the
    // reader nothing about what was in it, which is the moment they most need to know.
    expect(formatDateWithPreset('not-a-date', 'short')).to.equal('not-a-date');
  });

  it('renders an empty cell as empty', () => {
    expect(formatDateWithPreset(null, 'short')).to.equal('');
    expect(formatDateWithPreset(undefined, 'short')).to.equal('');
    expect(formatDateWithPreset('', 'short')).to.equal('');
  });

  it('falls through to the raw value for an unknown preset', () => {
    // `dateFormat` is doc-authored and survives an AI tool call, so an unknown value is reachable.
    // Falling through beats matching a neighbouring preset by accident.
    expect(formatDateWithPreset('2026-03-04', 'nonsense' as never)).to.equal('2026-03-04');
  });

  it('keeps the time for a datetime under the dateTime preset', () => {
    setActiveStudioLocale('en-GB');
    const rendered = formatDateWithPreset('2026-03-04T14:30:00Z', 'dateTime');
    expect(rendered).to.match(/\d{2}:\d{2}/);
  });
});
