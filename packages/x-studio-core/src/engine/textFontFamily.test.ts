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

  it('does not return the inherited Object.prototype member for a prototype-name value (prototype-chain lookup fix)', () => {
    // Pre-fix, `NAMED_FONT_STACKS['toString']` resolved the inherited
    // `Object.prototype.toString` *function* (truthy on the prototype chain), which was
    // returned directly — a non-string value entirely bypassing the `isSafeFontFamily`
    // allow-list this function exists to enforce. Post-fix, `Object.hasOwn` guards the
    // named-stack lookup, so it falls through to `isSafeFontFamily`: since these
    // particular names are themselves shaped like safe CSS font-family literals (plain
    // word characters), they're returned as literal strings, never as the prototype value.
    for (const protoName of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      const result = resolveTextFontFamily(protoName);
      expect(typeof result).toBe('string');
      expect(result).toBe(protoName);
    }
  });
});
