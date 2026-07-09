import { describe, expect, it } from 'vitest';
import { escapeCsvCell } from './csvUtils';

describe('escapeCsvCell', () => {
  it('quotes plain text', () => {
    expect(escapeCsvCell('hello')).toBe('"hello"');
    expect(escapeCsvCell('')).toBe('""');
  });

  it('escapes embedded quotes and preserves commas/newlines inside quotes', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('prefixes formula-injection lead characters with a single quote', () => {
    expect(escapeCsvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(escapeCsvCell('+cmd')).toBe('"\'+cmd"');
    expect(escapeCsvCell('-2+3')).toBe('"\'-2+3"');
    expect(escapeCsvCell('@ref')).toBe('"\'@ref"');
    expect(escapeCsvCell('\ttab')).toBe('"\'\ttab"');
    expect(escapeCsvCell('\rcr')).toBe('"\'\rcr"');
  });

  it('does not prefix text that merely contains a formula character mid-string', () => {
    expect(escapeCsvCell('a=b')).toBe('"a=b"');
    expect(escapeCsvCell('total (net)')).toBe('"total (net)"');
  });
});
