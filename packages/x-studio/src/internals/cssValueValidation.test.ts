import { describe, expect, it } from 'vitest';
import {
  isSafeCssColor,
  sanitizeCssColor,
  isSafeFontFamily,
  sanitizeFontSize,
  sanitizeFiniteNumber,
  sanitizeFontWeight,
  isSafeTextAlign,
  isSafeFontWeightKeyword,
  sanitizeCssIdentifierToken,
} from './cssValueValidation';

// Finding 1: these validators are the render-time boundary that stops a doc-authored CSS
// string (reachable via `loadSerializedState`/the AI `update_widget` tool call) from
// injecting arbitrary CSS rules when interpolated into an Emotion `sx` prop.
describe('cssValueValidation (finding 1)', () => {
  describe('isSafeCssColor / sanitizeCssColor', () => {
    it('accepts common valid color syntaxes', () => {
      expect(isSafeCssColor('#fff')).toBe(true);
      expect(isSafeCssColor('#ff8800')).toBe(true);
      expect(isSafeCssColor('#ff8800cc')).toBe(true);
      expect(isSafeCssColor('red')).toBe(true);
      expect(isSafeCssColor('cornflowerblue')).toBe(true);
      expect(isSafeCssColor('rgb(255, 0, 0)')).toBe(true);
      expect(isSafeCssColor('rgba(255, 0, 0, 0.5)')).toBe(true);
      expect(isSafeCssColor('hsl(200, 50%, 50%)')).toBe(true);
    });

    it('rejects a CSS-injecting string', () => {
      const payload = 'red;} .MuiCard-root{background:url(https://evil/leak)';
      expect(isSafeCssColor(payload)).toBe(false);
      expect(sanitizeCssColor(payload)).toBeUndefined();
      expect(sanitizeCssColor(payload, 'text.primary')).toBe('text.primary');
    });

    it('rejects non-string / empty values', () => {
      expect(isSafeCssColor(undefined)).toBe(false);
      expect(isSafeCssColor(null)).toBe(false);
      expect(isSafeCssColor(42)).toBe(false);
      expect(isSafeCssColor('   ')).toBe(false);
      expect(isSafeCssColor('')).toBe(false);
    });

    it('sanitizeCssColor returns the value unchanged when valid', () => {
      expect(sanitizeCssColor('#123456')).toBe('#123456');
    });
  });

  describe('isSafeFontFamily', () => {
    it('accepts a normal comma-separated font stack', () => {
      expect(isSafeFontFamily('Fraunces, "Inter Tight", serif')).toBe(true);
      expect(isSafeFontFamily("'Courier New', Courier, monospace")).toBe(true);
    });

    it('rejects a CSS-injecting string', () => {
      const payload = 'serif;} .MuiCard-root{background:url(https://evil/leak)';
      expect(isSafeFontFamily(payload)).toBe(false);
    });

    it('rejects non-string / empty values', () => {
      expect(isSafeFontFamily(undefined)).toBe(false);
      expect(isSafeFontFamily('')).toBe(false);
      expect(isSafeFontFamily('   ')).toBe(false);
    });

    // An unbalanced quote clears the character allow-list (`;{}():/` are all absent) but
    // leaves stylis parsing the remainder of the stylesheet as a string literal, swallowing
    // every declaration after it — a styling denial of service rather than an injection.
    it('rejects unbalanced quotes', () => {
      expect(isSafeFontFamily('Inter"')).toBe(false);
      expect(isSafeFontFamily('\'Inter"')).toBe(false);
      expect(isSafeFontFamily('"Inter')).toBe(false);
      expect(isSafeFontFamily("Inter'")).toBe(false);
      expect(isSafeFontFamily('Fraunces, "Inter Tight, serif')).toBe(false);
      expect(isSafeFontFamily('Fraunces, In"ter, serif')).toBe(false);
    });

    it('rejects empty families in the stack', () => {
      expect(isSafeFontFamily('Inter,')).toBe(false);
      expect(isSafeFontFamily(',Inter')).toBe(false);
      expect(isSafeFontFamily('Inter,,serif')).toBe(false);
    });

    it('still accepts every legitimate stack shape', () => {
      expect(isSafeFontFamily('serif')).toBe(true);
      expect(isSafeFontFamily('Helvetica Neue, Arial, sans-serif')).toBe(true);
      expect(isSafeFontFamily('"Helvetica Neue"')).toBe(true);
      expect(isSafeFontFamily('  Inter ,  serif  ')).toBe(true);
    });
  });

  describe('sanitizeFontSize / sanitizeFiniteNumber', () => {
    it('accepts a positive finite number', () => {
      expect(sanitizeFontSize(16)).toBe(16);
      expect(sanitizeFiniteNumber(0)).toBe(0);
      expect(sanitizeFiniteNumber(-1, -5)).toBe(-1);
    });

    it('rejects non-numeric, non-finite, zero/negative (for font size), and below-min values', () => {
      expect(sanitizeFontSize('16px' as unknown as number)).toBeUndefined();
      expect(sanitizeFontSize(Number.NaN)).toBeUndefined();
      expect(sanitizeFontSize(Number.POSITIVE_INFINITY)).toBeUndefined();
      expect(sanitizeFontSize(0)).toBeUndefined();
      expect(sanitizeFontSize(-4)).toBeUndefined();
      expect(sanitizeFiniteNumber(-1)).toBeUndefined();
      expect(sanitizeFiniteNumber(undefined)).toBeUndefined();
    });
  });

  describe('sanitizeFontWeight (finding 2)', () => {
    it('accepts numbers within the valid 100-900 CSS font-weight range', () => {
      expect(sanitizeFontWeight(100)).toBe(100);
      expect(sanitizeFontWeight(400)).toBe(400);
      expect(sanitizeFontWeight(900)).toBe(900);
    });

    it('rejects out-of-range and non-numeric values, including a CSS-injecting string', () => {
      expect(sanitizeFontWeight(0)).toBeUndefined();
      expect(sanitizeFontWeight(99)).toBeUndefined();
      expect(sanitizeFontWeight(901)).toBeUndefined();
      expect(sanitizeFontWeight(Number.NaN)).toBeUndefined();
      expect(sanitizeFontWeight(undefined)).toBeUndefined();
      expect(sanitizeFontWeight('700;} .x{background:url(https://evil/leak)')).toBeUndefined();
    });
  });

  describe('isSafeTextAlign (findings 2 & 3)', () => {
    it('accepts the three valid alignment keywords', () => {
      expect(isSafeTextAlign('left')).toBe(true);
      expect(isSafeTextAlign('center')).toBe(true);
      expect(isSafeTextAlign('right')).toBe(true);
    });

    it('rejects any other value, including a CSS-injecting string', () => {
      expect(isSafeTextAlign('justify')).toBe(false);
      expect(isSafeTextAlign(undefined)).toBe(false);
      expect(isSafeTextAlign(42)).toBe(false);
      expect(isSafeTextAlign('left;} .x{background:url(https://evil/leak)')).toBe(false);
    });
  });

  describe('isSafeFontWeightKeyword (finding 4)', () => {
    it('accepts "bold" and "normal"', () => {
      expect(isSafeFontWeightKeyword('bold')).toBe(true);
      expect(isSafeFontWeightKeyword('normal')).toBe(true);
    });

    it('rejects any other value, including a CSS-injecting string', () => {
      expect(isSafeFontWeightKeyword('bolder')).toBe(false);
      expect(isSafeFontWeightKeyword(700)).toBe(false);
      expect(isSafeFontWeightKeyword(undefined)).toBe(false);
      expect(isSafeFontWeightKeyword('bold;} .x{background:url(https://evil/leak)')).toBe(false);
    });
  });

  describe('sanitizeCssIdentifierToken (finding 5)', () => {
    it('leaves an already-safe identifier untouched', () => {
      expect(sanitizeCssIdentifierToken('widget-1_ABC')).toBe('widget-1_ABC');
    });

    it('strips CSS/selector metacharacters out of a hostile widget id', () => {
      const hostileId = 'w{}html{display:none}.x';
      const sanitized = sanitizeCssIdentifierToken(hostileId);
      expect(sanitized).toBe('whtmldisplaynonex');
      expect(sanitized).not.toContain('{');
      expect(sanitized).not.toContain('}');
      expect(sanitized).not.toContain(':');
      expect(sanitized).not.toContain('.');
      expect(sanitized).not.toContain(' ');
    });

    // Same class as the color/font validators above: the id is only *typed* as a string, and
    // `null.replace(...)` from a render path is worse than an empty class token.
    it('returns an empty token for a non-string id instead of throwing', () => {
      expect(sanitizeCssIdentifierToken(undefined)).toBe('');
      expect(sanitizeCssIdentifierToken(null)).toBe('');
      expect(sanitizeCssIdentifierToken(42)).toBe('');
      expect(sanitizeCssIdentifierToken({})).toBe('');
    });
  });
});
