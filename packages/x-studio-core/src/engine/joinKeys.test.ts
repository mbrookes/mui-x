import { describe, expect, it } from 'vitest';
import { collectKeySet, indexRowsByKey, normalizeJoinKey } from './joinKeys';

describe('joinKeys', () => {
  describe('normalizeJoinKey', () => {
    it('coerces a number and the equivalent string to the same key (the core bug fix)', () => {
      expect(normalizeJoinKey(5)).toBe('5');
      expect(normalizeJoinKey('5')).toBe('5');
      expect(normalizeJoinKey(5)).toBe(normalizeJoinKey('5'));
    });

    it('maps null and undefined to null (a missing key that never joins)', () => {
      expect(normalizeJoinKey(null)).toBe(null);
      expect(normalizeJoinKey(undefined)).toBe(null);
    });

    it('keeps empty string distinct from a missing key', () => {
      expect(normalizeJoinKey('')).toBe('');
      expect(normalizeJoinKey('')).not.toBe(normalizeJoinKey(null));
    });

    it('normalizes Date to its ISO string so equal instants join', () => {
      const iso = '2024-01-02T03:04:05.000Z';
      expect(normalizeJoinKey(new Date(iso))).toBe(iso);
      expect(normalizeJoinKey(new Date(iso))).toBe(normalizeJoinKey(new Date(iso)));
    });

    it('treats plain objects/arrays as no key', () => {
      expect(normalizeJoinKey({})).toBe(null);
      expect(normalizeJoinKey([1, 2])).toBe(null);
    });

    it('coerces booleans consistently', () => {
      expect(normalizeJoinKey(true)).toBe('true');
      expect(normalizeJoinKey(false)).toBe('false');
    });
  });

  describe('indexRowsByKey', () => {
    it('indexes by normalized key and skips rows with a missing key', () => {
      const rows = [
        { id: 1, name: 'a' },
        { id: '2', name: 'b' },
        { id: null, name: 'c' },
      ];
      const map = indexRowsByKey(rows, 'id');
      expect(map.get('1')).toEqual({ id: 1, name: 'a' });
      expect(map.get('2')).toEqual({ id: '2', name: 'b' });
      expect(map.has('')).toBe(false);
      expect(map.size).toBe(2);
    });

    it('keeps the FIRST row per key by default', () => {
      const rows = [
        { id: 1, name: 'first' },
        { id: '1', name: 'second' },
      ];
      expect(indexRowsByKey(rows, 'id').get('1')).toEqual({ id: 1, name: 'first' });
    });

    it('keeps the LAST row per key when keepLast is set', () => {
      const rows = [
        { id: 1, name: 'first' },
        { id: '1', name: 'second' },
      ];
      expect(indexRowsByKey(rows, 'id', { keepLast: true }).get('1')).toEqual({
        id: '1',
        name: 'second',
      });
    });
  });

  describe('collectKeySet', () => {
    it('collects normalized keys and excludes missing ones', () => {
      const rows = [{ fk: 1 }, { fk: '1' }, { fk: 2 }, { fk: null }, { fk: undefined }];
      const set = collectKeySet(rows, 'fk');
      expect([...set].sort()).toEqual(['1', '2']);
    });
  });
});
