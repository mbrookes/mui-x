import { describe, expect, it } from 'vitest';
import type { StudioDataField } from '../models';
import {
  getFieldCapabilities,
  fieldHasCapability,
  fieldsForCapability,
} from './fieldCapabilities';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeField(
  type: StudioDataField['type'],
  overrides?: Partial<StudioDataField>,
): StudioDataField {
  return { id: 'f', label: 'F', type, ...overrides };
}

// ─── getFieldCapabilities ─────────────────────────────────────────────────────

describe('getFieldCapabilities', () => {
  it('number → numeric + rankTarget', () => {
    expect(getFieldCapabilities(makeField('number'))).toEqual(['numeric', 'rankTarget']);
  });

  it('string → categorical', () => {
    expect(getFieldCapabilities(makeField('string'))).toEqual(['categorical']);
  });

  it('boolean → categorical', () => {
    expect(getFieldCapabilities(makeField('boolean'))).toEqual(['categorical']);
  });

  it('date → temporal', () => {
    expect(getFieldCapabilities(makeField('date'))).toEqual(['temporal']);
  });

  it('datetime → temporal', () => {
    expect(getFieldCapabilities(makeField('datetime'))).toEqual(['temporal']);
  });

  it('capabilities override takes precedence over type', () => {
    const field = makeField('number', { capabilities: ['categorical'] });
    expect(getFieldCapabilities(field)).toEqual(['categorical']);
  });

  it('empty capabilities array falls back to type defaults', () => {
    const field = makeField('number', { capabilities: [] });
    expect(getFieldCapabilities(field)).toEqual(['numeric', 'rankTarget']);
  });
});

// ─── fieldHasCapability ───────────────────────────────────────────────────────

describe('fieldHasCapability', () => {
  it('number has numeric capability', () => {
    expect(fieldHasCapability(makeField('number'), 'numeric')).toBe(true);
  });

  it('number does NOT have categorical capability', () => {
    expect(fieldHasCapability(makeField('number'), 'categorical')).toBe(false);
  });

  it('string has categorical capability', () => {
    expect(fieldHasCapability(makeField('string'), 'categorical')).toBe(true);
  });

  it('string does NOT have numeric capability', () => {
    expect(fieldHasCapability(makeField('string'), 'numeric')).toBe(false);
  });

  it('date has temporal capability', () => {
    expect(fieldHasCapability(makeField('date'), 'temporal')).toBe(true);
  });

  it('date does NOT have numeric capability', () => {
    expect(fieldHasCapability(makeField('date'), 'numeric')).toBe(false);
  });

  it('number has rankTarget capability', () => {
    expect(fieldHasCapability(makeField('number'), 'rankTarget')).toBe(true);
  });

  it('string does NOT have rankTarget capability', () => {
    expect(fieldHasCapability(makeField('string'), 'rankTarget')).toBe(false);
  });

  it('capability override: number treated as categorical', () => {
    const field = makeField('number', { capabilities: ['categorical'] });
    expect(fieldHasCapability(field, 'categorical')).toBe(true);
    expect(fieldHasCapability(field, 'numeric')).toBe(false);
  });
});

// ─── fieldsForCapability ──────────────────────────────────────────────────────

describe('fieldsForCapability', () => {
  const fields: StudioDataField[] = [
    makeField('number', { id: 'revenue', label: 'Revenue' }),
    makeField('string', { id: 'category', label: 'Category' }),
    makeField('boolean', { id: 'active', label: 'Active' }),
    makeField('date', { id: 'created', label: 'Created' }),
    makeField('datetime', { id: 'updated', label: 'Updated' }),
  ];

  it('numeric filters to number fields only', () => {
    const result = fieldsForCapability(fields, 'numeric');
    expect(result.map((f) => f.id)).toEqual(['revenue']);
  });

  it('categorical filters to string + boolean fields', () => {
    const result = fieldsForCapability(fields, 'categorical');
    expect(result.map((f) => f.id)).toEqual(['category', 'active']);
  });

  it('temporal filters to date + datetime fields', () => {
    const result = fieldsForCapability(fields, 'temporal');
    expect(result.map((f) => f.id)).toEqual(['created', 'updated']);
  });

  it('rankTarget filters to number fields', () => {
    const result = fieldsForCapability(fields, 'rankTarget');
    expect(result.map((f) => f.id)).toEqual(['revenue']);
  });

  it('returns empty array when no fields match', () => {
    const stringOnly = [makeField('string', { id: 's' })];
    expect(fieldsForCapability(stringOnly, 'numeric')).toEqual([]);
  });

  it('respects capability override: region_id number treated as categorical', () => {
    const regionId = makeField('number', { id: 'region_id', capabilities: ['categorical'] });
    const mixed = [...fields, regionId];
    expect(fieldsForCapability(mixed, 'categorical').map((f) => f.id)).toContain('region_id');
    expect(fieldsForCapability(mixed, 'numeric').map((f) => f.id)).not.toContain('region_id');
  });
});
