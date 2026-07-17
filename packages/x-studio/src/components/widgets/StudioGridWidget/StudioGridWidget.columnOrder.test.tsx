import { describe, expect, it } from 'vitest';
import { computeOrderedFieldIds } from './StudioGridWidget';

// ─── Column render order follows `config.columns` (architecture review 1.2) ──
//
// The grid used to build its `columns` array from the data-source field order,
// consuming `widget.config.columns` only for visibility. `GridSetupPanel`'s
// drag-and-drop / keyboard reorder commits a new order to `config.columns`, but
// the rendered grid never reflected it. The fix derives column order from
// `config.columns` (configured fields first, in their stored order).
//
// This exercises `computeOrderedFieldIds` directly rather than through a full
// DataGridPremium render: in jsdom (no real layout engine), a `flex`-based
// column with a zero measured container width renders no field-specific header
// cells at all (only a `MuiDataGrid-filler` placeholder) regardless of column
// order, so asserting on rendered DOM order is not meaningful here — see the
// sibling `StudioGridWidget.writeBack.test.tsx`'s fixed-pixel-width workaround
// for the same constraint on a different concern.

const allFieldIds = ['id', 'alpha', 'beta', 'gamma'];

describe('computeOrderedFieldIds', () => {
  it('orders configured fields first, in their stored order, ahead of the data-source order', () => {
    const configColumns = [
      { fieldId: 'gamma' },
      { fieldId: 'id' },
      { fieldId: 'beta' },
      { fieldId: 'alpha' },
    ];

    const order = computeOrderedFieldIds(configColumns, allFieldIds);

    expect(order).toEqual(['gamma', 'id', 'beta', 'alpha']);
    // Explicitly assert the regression: order must NOT be the data-source order.
    expect(order).not.toEqual(['id', 'alpha', 'beta', 'gamma']);
  });

  it('appends fields missing from config.columns after the configured ones, in data-source order', () => {
    const configColumns = [{ fieldId: 'beta' }, { fieldId: 'gamma' }];

    const order = computeOrderedFieldIds(configColumns, allFieldIds);

    expect(order).toEqual(['beta', 'gamma', 'id', 'alpha']);
  });

  it('falls back to data-source order when config.columns is undefined', () => {
    expect(computeOrderedFieldIds(undefined, allFieldIds)).toEqual(allFieldIds);
  });

  it('falls back to data-source order when config.columns is empty', () => {
    expect(computeOrderedFieldIds([], allFieldIds)).toEqual(allFieldIds);
  });

  it('ignores a configured fieldId no longer present in the data source', () => {
    const configColumns = [{ fieldId: 'gamma' }, { fieldId: 'ghost' }, { fieldId: 'id' }];

    const order = computeOrderedFieldIds(configColumns, allFieldIds);

    expect(order).toEqual(['gamma', 'id', 'alpha', 'beta']);
  });

  // ─── Colliding bare field ids are de-duplicated (finding T1.2) ──────────────
  // A cross-source column can share a bare `fieldId` with a primary one (e.g. a
  // primary `id` plus a related `customers.id`). Emitting the id twice builds two
  // `GridColDef`s with the same `field` (duplicate React key, undefined DataGrid
  // behaviour). The first occurrence must win; the duplicate is dropped.
  it('de-duplicates a bare fieldId shared by a primary and a cross-source column', () => {
    const configColumns = [
      { fieldId: 'id' },
      { fieldId: 'id', sourceId: 'customers' },
      { fieldId: 'beta' },
    ];

    const order = computeOrderedFieldIds(configColumns, allFieldIds);

    expect(order).toEqual(['id', 'beta', 'alpha', 'gamma']);
    // No duplicate field id survives.
    expect(order.filter((f) => f === 'id')).toHaveLength(1);
  });
});
