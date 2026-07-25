import * as React from 'react';
import { createRenderer, fireEvent, screen, waitFor } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type {
  ClientMutationDescriptor,
  ClientMutationResult,
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioWidgetOf,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { studioRequestCache } from '../../../internals/StudioRequestCache';
import { StudioGridWidget } from './StudioGridWidget';

const { render } = createRenderer();

// ─── Synthetic row identity must never overwrite the row's real `id` value ────
//
// The `rows` memo used to return `{ ...row, id }` — spreading the synthesized DataGrid
// row id OVER the row's own data. For a source whose `id` column is nullable or
// non-unique, that replaced the real value with an internal token (`grid-1-1`,
// `grid-1-dup-2`) in the row model itself, so:
//
//   - the visible `id` column rendered the token instead of the data,
//   - `handleCellClick` emitted the token as a cross-filter value,
//   - and write-back ran `WHERE id = 'grid-1-1'`, which matches zero rows — a 0-row
//     update that most adapters report as `{ ok: true }`, so `processRowUpdate`
//     resolved and the grid painted the edit as committed while nothing was persisted.
//
// The identity now lives on `__rowId` (the field `getRowId` already reads first), and
// `row.id` is left untouched.

beforeEach(() => {
  studioRequestCache.clear();
});

afterEach(() => {
  studioRequestCache.clear();
});

function makeSource(submitMutation?: ReturnType<typeof vi.fn>): StudioDataSource {
  const rows = [
    { id: 'r1', label: 'A' },
    // Nullable id column → this row needs a synthetic grid id.
    { id: null, label: 'B' },
    // Duplicate non-unique id → this row needs a deduped grid id.
    { id: 'r1', label: 'C' },
  ];
  return {
    id: 'src',
    label: 'Widgets',
    tableName: 'widgets_table',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'label', label: 'Label', type: 'string' },
    ],
    adapter: submitMutation
      ? {
          getRows: async () => ({ rows }),
          submitMutation: submitMutation as unknown as (
            descriptor: ClientMutationDescriptor,
          ) => Promise<ClientMutationResult>,
        }
      : undefined,
    rows: submitMutation ? undefined : rows,
  };
}

function makeWidget(): StudioWidgetOf<'grid'> {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'src',
    config: { gridPkField: 'id', crossFilterField: 'id' },
  };
}

async function setup(submitMutation?: ReturnType<typeof vi.fn>) {
  const source = makeSource(submitMutation);
  const widget = makeWidget();
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    },
    runtime: { dataSources: { src: source } },
  };
  const { controller, wrapper } = createStudioHarness({ initialState });
  const { container, ...utils } = render(
    <StudioGridWidget
      widget={widget}
      dataSource={source}
      pageId="page-1"
      // jsdom has no real layout engine, so the production `flex` column widths resolve
      // to 0 and DataGridPremium renders filler cells instead of real ones.
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          columns: [
            { field: 'id', width: 100 },
            { field: 'label', width: 100, editable: true },
          ],
        },
      }}
    />,
    { wrapper },
  );

  if (submitMutation) {
    // Wait for the async adapter fetch (`getRows`) to resolve and rows to render.
    await screen.findByText('A');
  }

  return { controller, source, widget, container, ...utils };
}

function cellText(container: HTMLElement, rowId: string, field: string): string | null {
  return (
    container.querySelector(`[data-id="${rowId}"] [data-field="${field}"]`)?.textContent ?? null
  );
}

/** Drives a full cell edit through the real DOM, as a user would. */
function editCell(container: HTMLElement, rowId: string, field: string, value: string) {
  const cell = container.querySelector(`[data-id="${rowId}"] [data-field="${field}"]`);
  expect(cell).not.toBe(null);
  fireEvent.doubleClick(cell as HTMLElement);
  const input = (cell as HTMLElement).querySelector('input');
  expect(input).not.toBe(null);
  fireEvent.change(input!, { target: { value } });
  fireEvent.keyDown(input!, { key: 'Enter' });
}

describe('StudioGridWidget — synthetic row identity does not clobber `row.id`', () => {
  it('renders every row under a distinct grid id while keeping the real `id` cell value', async () => {
    const { container } = await setup();

    // Grid identities stay unique: real id, synthetic (nullable id), deduped (duplicate id).
    expect(container.querySelector('[data-id="r1"]')).not.toBe(null);
    expect(container.querySelector('[data-id="grid-1-1"]')).not.toBe(null);
    expect(container.querySelector('[data-id="grid-1-dup-2"]')).not.toBe(null);

    // ...but the rendered `id` COLUMN shows the row's real data, not the internal token.
    expect(cellText(container, 'r1', 'id')).toBe('r1');
    expect(cellText(container, 'grid-1-1', 'id')).toBe('');
    expect(cellText(container, 'grid-1-dup-2', 'id')).toBe('r1');
  });

  it('emits the real cell value as a cross-filter, not the synthetic identity', async () => {
    const { controller, container } = await setup();

    const cell = container.querySelector('[data-id="grid-1-dup-2"] [data-field="id"]');
    expect(cell).not.toBe(null);
    fireEvent.click(cell as HTMLElement);

    const applied = controller.getState().doc.filters.find((f) => f.scope.kind === 'cross-filter');
    expect(applied?.field).toBe('id');
    // Pre-fix: 'grid-1-dup-2' — a value no row in any source has, blanking every
    // same-source widget.
    expect(applied?.value).toBe('r1');
  });

  it("targets the PK column's real value in the write-back where clause", async () => {
    const submitMutation = vi.fn().mockResolvedValue({ ok: true });
    const { container } = await setup(submitMutation);

    editCell(container, 'grid-1-dup-2', 'label', 'Edited');

    await waitFor(() => expect(submitMutation).toHaveBeenCalledTimes(1));
    expect(submitMutation).toHaveBeenCalledWith({
      operation: 'update',
      table: 'widgets_table',
      values: { label: 'Edited' },
      // Pre-fix: `value: 'grid-1-dup-2'` — matched zero rows, reported as success.
      where: [{ column: 'id', operator: 'eq', value: 'r1' }],
    });
  });

  it('never sends the internal `__rowId`/`__highlighted` fields in the mutation values', async () => {
    const submitMutation = vi.fn().mockResolvedValue({ ok: true });
    const { container } = await setup(submitMutation);

    editCell(container, 'r1', 'label', 'Edited');

    await waitFor(() => expect(submitMutation).toHaveBeenCalledTimes(1));
    const values = submitMutation.mock.calls[0][0].values as Record<string, unknown>;
    expect(Object.keys(values)).toEqual(['label']);
  });

  it('refuses to write back a row whose PK value is null instead of reporting success', async () => {
    const submitMutation = vi.fn().mockResolvedValue({ ok: true });
    const { container } = await setup(submitMutation);

    editCell(container, 'grid-1-1', 'label', 'Edited');

    // A `WHERE id = NULL` update matches nothing and would be reported as `{ ok: true }`
    // by most adapters, so the edit must be rejected before it is sent at all.
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBe(null);
    });
    expect(submitMutation).not.toHaveBeenCalled();
    // The stuck cell reverts to its pre-edit value.
    await waitFor(() => {
      expect(cellText(container, 'grid-1-1', 'label')).toBe('B');
    });
  });
});
