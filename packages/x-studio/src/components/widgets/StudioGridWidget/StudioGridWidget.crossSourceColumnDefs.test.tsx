import { describe, expect, it } from 'vitest';
import type { StudioDataSource, StudioWidgetConfig } from '../../../models';
import {
  computeOrderedFieldIds,
  resolveCrossSourceFieldDefs,
  buildGridColumnDefs,
} from './StudioGridWidget';

// ─── Cross-source display columns must actually produce a GridColDef (finding 1.1) ──
//
// `GridSetupPanel` lets a user add a grid column whose `sourceId` differs from the
// widget's own source (a many-to-one "display column", e.g. showing the customer's
// company name on an orders grid), and `useWidgetRows.ts`'s row enrichment joins in
// a real value for it on every row. But `computeOrderedFieldIds` used to be handed
// only the widget's own-source field ids + expression-field ids, so a configured
// cross-source column's id never matched anything in that list and was silently
// dropped — no `GridColDef` was ever built for it, and it never rendered, even
// though the row data behind it was fully populated.
//
// The existing `StudioGridWidget.crossHighlightCrossSource.test.tsx` regression test
// configures a cross-source column but renders through
// `slotProps={{ dataGrid: { columns: [...] } }}`, which REPLACES the production
// `columns` prop wholesale — so that test would still pass even if this exact bug
// reappeared. These tests instead exercise the real functions the component's
// `columns`/`orderedFieldIds` memos call — `resolveCrossSourceFieldDefs`,
// `computeOrderedFieldIds`, and `buildGridColumnDefs` — using only `config.columns`,
// with no `slotProps` override anywhere in sight.

const dataSources: Record<string, StudioDataSource> = {
  orders: {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'customerId', label: 'Customer', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: [],
  },
  customers: {
    id: 'customers',
    label: 'Customers',
    fields: [
      { id: 'company', label: 'Company', type: 'string' },
      { id: 'lifetimeValue', label: 'Lifetime Value', type: 'number', format: 'currency' },
    ],
    rows: [],
  },
};

const configColumns: StudioWidgetConfig['columns'] = [
  { fieldId: 'total' },
  { fieldId: 'company', sourceId: 'customers' },
  { fieldId: 'lifetimeValue', sourceId: 'customers' },
];

describe('resolveCrossSourceFieldDefs', () => {
  it('resolves a configured cross-source column against dataSources[c.sourceId]', () => {
    const defs = resolveCrossSourceFieldDefs(configColumns, 'orders', dataSources);
    expect(defs.get('company')).toEqual({ id: 'company', label: 'Company', type: 'string' });
    expect(defs.get('lifetimeValue')?.format).toBe('currency');
  });

  it('ignores own-source columns (no sourceId, or sourceId equal to the widget source)', () => {
    const defs = resolveCrossSourceFieldDefs(configColumns, 'orders', dataSources);
    expect(defs.has('total')).toBe(false);
  });

  it('silently omits a cross-source column whose field cannot be resolved', () => {
    const defs = resolveCrossSourceFieldDefs(
      [{ fieldId: 'doesNotExist', sourceId: 'customers' }],
      'orders',
      dataSources,
    );
    expect(defs.has('doesNotExist')).toBe(false);
  });
});

describe('computeOrderedFieldIds + resolveCrossSourceFieldDefs integration', () => {
  it('a configured cross-source column id survives into the ordered field list', () => {
    // This is exactly what `StudioGridWidget`'s `allFieldIds` memo now does: start from
    // the own-source + expression-field ids, then fold in any resolvable cross-source
    // column ids that aren't already present.
    const ownFieldIds = dataSources.orders.fields.map((f) => f.id);
    const crossSourceFieldDefs = resolveCrossSourceFieldDefs(configColumns, 'orders', dataSources);
    const allFieldIds = [...ownFieldIds, ...crossSourceFieldDefs.keys()];

    const ordered = computeOrderedFieldIds(configColumns, allFieldIds);

    // Before the fix, 'company' and 'lifetimeValue' would never appear here because
    // `allFieldIds` never included them in the first place.
    expect(ordered).toContain('company');
    expect(ordered).toContain('lifetimeValue');
  });
});

describe('buildGridColumnDefs', () => {
  it('produces a real GridColDef for a configured cross-source column, with format/label resolved', () => {
    const crossSourceFieldDefs = resolveCrossSourceFieldDefs(configColumns, 'orders', dataSources);
    const orderedFieldIds = ['total', 'company', 'lifetimeValue'];

    const columns = buildGridColumnDefs(
      orderedFieldIds,
      dataSources.orders,
      [],
      crossSourceFieldDefs,
      /* isEditable */ true,
      /* pkField */ 'id',
    );

    const companyCol = columns.find((c) => c.field === 'company');
    expect(companyCol).toBeDefined();
    expect(companyCol!.headerName).toBe('Company');
    expect(companyCol!.type).toBe('string');

    const lifetimeValueCol = columns.find((c) => c.field === 'lifetimeValue');
    expect(lifetimeValueCol).toBeDefined();
    expect(lifetimeValueCol!.headerName).toBe('Lifetime Value');
    expect(lifetimeValueCol!.type).toBe('number');
    // Numeric cross-source columns get the same currency/precision-aware valueFormatter
    // own-source numeric columns get.
    expect(lifetimeValueCol!.valueFormatter).toBeDefined();
  });

  it('never marks a cross-source column editable, even when write-back is enabled', () => {
    const crossSourceFieldDefs = resolveCrossSourceFieldDefs(configColumns, 'orders', dataSources);
    const columns = buildGridColumnDefs(
      ['total', 'company'],
      dataSources.orders,
      [],
      crossSourceFieldDefs,
      /* isEditable */ true,
      /* pkField */ 'id',
    );

    const companyCol = columns.find((c) => c.field === 'company');
    expect(companyCol!.editable).toBe(false);
    // Own-source, non-PK column stays editable as before.
    const totalCol = columns.find((c) => c.field === 'total');
    expect(totalCol!.editable).toBe(true);
  });

  it('own-source and expression fields still take priority over a same-id cross-source column', () => {
    // Defensive: if a cross-source column id happened to collide with an own-source
    // field id, the own-source definition must win (matches the enrichment/label
    // resolution priority order used throughout the widget).
    const crossSourceFieldDefs = new Map(
      resolveCrossSourceFieldDefs(configColumns, 'orders', dataSources),
    );
    crossSourceFieldDefs.set('total', { id: 'total', label: 'Cross Total', type: 'string' });

    const columns = buildGridColumnDefs(
      ['total'],
      dataSources.orders,
      [],
      crossSourceFieldDefs,
      false,
      undefined,
    );

    expect(columns[0].headerName).toBe('Total');
    expect(columns[0].type).toBe('number');
  });
});
