import { describe, expect, it } from 'vitest';
import { resolveTextFontFamily } from './textFontFamily';

describe('resolveTextFontFamily (finding 1)', () => {
  it('maps the three named keywords to curated stacks', () => {
    expect(resolveTextFontFamily('sans-serif')).toBe('Arial, Helvetica, sans-serif');
    expect(resolveTextFontFamily('serif')).toBe("Georgia, 'Times New Roman', Times, serif");
    expect(resolveTextFontFamily('monospace')).toBe("'Courier New', Courier, monospace");
  });

  it('passes through a valid literal CSS font-family stack', () => {
    expect(resolveTextFontFamily('Fraunces, "Inter Tight", serif')).toBe(
      'Fraunces, "Inter Tight", serif',
    );
  });

  it('returns undefined for an empty/undefined value', () => {
    expect(resolveTextFontFamily(undefined)).toBeUndefined();
    expect(resolveTextFontFamily('')).toBeUndefined();
  });

  it('returns undefined for a CSS-injecting literal instead of passing it through verbatim', () => {
    const payload = 'serif;} .MuiCard-root{background:url(https://evil/leak)';
    expect(resolveTextFontFamily(payload)).toBeUndefined();
  });

  it('returns undefined for a non-string value', () => {
    expect(resolveTextFontFamily(42 as unknown as string)).toBeUndefined();
  });
});
