import { describe, expect, it } from 'vitest';
import type { StudioDataField, StudioDataSource, StudioGridColumn } from '../../../models';
import { buildGridColumnDefs } from './StudioGridWidget';

/**
 * Per-column alignment and date presentation (AG_STUDIO_GAP_ANALYSIS XS-GRID-003).
 *
 * Asserted against `buildGridColumnDefs` — the production column-def path — rather than through a
 * rendered grid, for the same reason the cross-source column test does: rendering a
 * DataGridPremium to check a `GridColDef` property tests the grid, not this package.
 */

const SOURCE: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'id', label: 'ID', type: 'number' },
    { id: 'amount', label: 'Amount', type: 'number' },
    { id: 'created_at', label: 'Created', type: 'date' },
    { id: 'status', label: 'Status', type: 'string' },
  ] as StudioDataField[],
  rows: [],
};

function build(configs: Partial<StudioGridColumn>[] = []) {
  const presentation = new Map(
    configs.map((column) => [
      column.fieldId as string,
      { align: column.align, dateFormat: column.dateFormat },
    ]),
  );
  return buildGridColumnDefs(
    ['id', 'amount', 'created_at', 'status'],
    SOURCE,
    [],
    new Map(),
    false,
    undefined,
    presentation,
  );
}

function column(defs: ReturnType<typeof build>, field: string) {
  return defs.find((def) => def.field === field)!;
}

/**
 * `GridColDef` is a union over column types, so `valueFormatter`'s value parameter narrows to
 * `never` unless the column type is known statically. The cast is to the call shape, not to the
 * arguments: casting each argument would hide a genuine arity change, whereas this keeps the
 * assertion about what the formatter DOES.
 */
function formatterOf(defs: ReturnType<typeof build>, field: string) {
  return column(defs, field).valueFormatter as unknown as (
    value: unknown,
    row: unknown,
    col: unknown,
    api: unknown,
  ) => string;
}

describe('grid column presentation', () => {
  it('leaves alignment undefined when nothing was configured', () => {
    // Omitted means "let the type decide" — the grid right-aligns a `number` column by itself.
    // Defaulting here would replace a type-aware default with a fixed one.
    const defs = build();
    expect(column(defs, 'amount').align).to.equal(undefined);
    expect(column(defs, 'status').align).to.equal(undefined);
  });

  it('applies a configured alignment to cells and header together', () => {
    // A right-aligned column under a left-aligned header reads as a rendering bug, so the header
    // follows the cells rather than being a second control.
    const defs = build([{ fieldId: 'id', align: 'left' }]);
    expect(column(defs, 'id').align).to.equal('left');
    expect(column(defs, 'id').headerAlign).to.equal('left');
  });

  it('lets a numeric id column be left-aligned', () => {
    // The case the override exists for: an id is numeric but reads as a label, and right-aligning
    // a table of them makes it unscannable.
    const defs = build([{ fieldId: 'id', align: 'left' }]);
    expect(column(defs, 'id').type).to.equal('number');
    expect(column(defs, 'id').align).to.equal('left');
  });

  it('formats a date column with the configured preset', () => {
    const defs = build([{ fieldId: 'created_at', dateFormat: 'year' }]);
    const formatter = formatterOf(defs, 'created_at');
    expect(formatter('2026-03-04', {}, {}, {})).to.equal('2026');
  });

  it('leaves a date column unformatted when no preset was chosen', () => {
    // No formatter at all rather than an identity one, so the grid's own date handling is
    // untouched for the columns nobody configured.
    const defs = build();
    expect(column(defs, 'created_at').valueFormatter).to.equal(undefined);
  });

  it('does not offer date formatting on a non-date column', () => {
    // A `dateFormat` on a string column is a config the UI cannot produce, but a persisted doc or
    // an AI tool call can. It must not reach the formatter, where it would render the value as a
    // date or as `Invalid Date`.
    const defs = build([{ fieldId: 'status', dateFormat: 'long' }]);
    expect(column(defs, 'status').valueFormatter).to.equal(undefined);
  });

  it('still formats numbers when a date preset is present on another column', () => {
    // The date branch is inserted ahead of the numeric one, so this pins that it did not shadow it.
    const numericSource: StudioDataSource = {
      ...SOURCE,
      fields: [
        { id: 'amount', label: 'Amount', type: 'number', format: 'currency' },
        { id: 'created_at', label: 'Created', type: 'date' },
      ] as StudioDataField[],
    };
    const defs = buildGridColumnDefs(
      ['amount', 'created_at'],
      numericSource,
      [],
      new Map(),
      false,
      undefined,
      new Map([['created_at', { dateFormat: 'year' as const }]]),
    );
    expect(defs.find((def) => def.field === 'amount')!.valueFormatter).to.not.equal(undefined);
  });

  it('works with no presentation map at all', () => {
    // The parameter is optional so every existing caller, and every test that predates it, keeps
    // compiling and behaving identically.
    const defs = buildGridColumnDefs(['amount'], SOURCE, [], new Map(), false, undefined);
    expect(defs[0].align).to.equal(undefined);
    expect(defs[0].valueFormatter).to.equal(undefined);
  });
});
