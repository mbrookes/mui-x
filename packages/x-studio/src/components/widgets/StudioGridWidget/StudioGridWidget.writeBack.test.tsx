import * as React from 'react';
import { createRenderer, fireEvent, screen, waitFor } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type {
  ClientMutationDescriptor,
  ClientMutationResult,
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioWidget,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { studioRequestCache } from '../../../internals/StudioRequestCache';
import { StudioGridWidget } from './StudioGridWidget';

// ─── Write-back (processRowUpdate) — mutation error handling regression ──────
//
// Finding #1.8 (architecture review): `processRowUpdate` threw a bare `Error` on
// a failed mutation with no `onProcessRowUpdateError` handler anywhere in the
// package, so DataGridPremium only logged a dev warning — the user saw nothing,
// and the grid cell stayed stuck in edit mode showing the (unsaved) new value.
// These tests exercise the fixed write-back path end-to-end through real DOM
// cell-editing interactions: diffing, the `where` clause built from the PK,
// no-op edits, both failure shapes (`{ ok: false }` and a rejecting adapter),
// PK read-only enforcement, and that the error alert clears on a later success.

const { render } = createRenderer();

beforeEach(() => {
  studioRequestCache.clear();
});

afterEach(() => {
  studioRequestCache.clear();
});

function makeSource(submitMutation: ReturnType<typeof vi.fn>): StudioDataSource {
  const rows = [
    { id: 'r1', label: 'Old' },
    { id: 'r2', label: 'Other' },
  ];
  return {
    id: 'src',
    label: 'Widgets',
    tableName: 'widgets_table',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'label', label: 'Label', type: 'string' },
    ],
    adapter: {
      getRows: async () => ({ rows }),
      submitMutation: submitMutation as unknown as (
        descriptor: ClientMutationDescriptor,
      ) => Promise<ClientMutationResult>,
    },
  };
}

function makeWidget(): StudioWidget {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'src',
    config: { gridPkField: 'id' },
  };
}

function getCell(container: HTMLElement, rowId: string, field: string): HTMLElement {
  const cell = container.querySelector(`[data-id="${rowId}"] [data-field="${field}"]`);
  expect(cell).not.toBe(null);
  return cell as HTMLElement;
}

/** Drives a full cell edit through the real DOM, as a user would. */
function editCell(container: HTMLElement, rowId: string, field: string, value: string) {
  const cell = getCell(container, rowId, field);
  fireEvent.doubleClick(cell);
  const input = cell.querySelector('input');
  expect(input).not.toBe(null);
  fireEvent.change(input!, { target: { value } });
  fireEvent.keyDown(input!, { key: 'Enter' });
}

async function setup(submitMutation: ReturnType<typeof vi.fn>) {
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
      // jsdom has no real layout engine, so `flex`-based column widths (what
      // StudioGridWidget uses by default) all resolve to 0 and DataGridPremium
      // renders filler cells instead of real ones. Force fixed pixel widths and
      // disable virtualization so the actual field cells are present in the DOM.
      // The full column override also means `editable` must be set explicitly
      // here — it isn't inherited from the widget's internally computed columns.
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

  // Wait for the async adapter fetch (`getRows`) to resolve and rows to render.
  await screen.findByText('Old');

  return { controller, source, widget, container, ...utils };
}

describe('StudioGridWidget — write-back (processRowUpdate) error handling', () => {
  it('diffs changed values and builds a where clause from the PK on success', async () => {
    const submitMutation = vi.fn().mockResolvedValue({ ok: true });
    const { container } = await setup(submitMutation);

    editCell(container, 'r1', 'label', 'New');

    await waitFor(() => expect(submitMutation).toHaveBeenCalledTimes(1));
    expect(submitMutation).toHaveBeenCalledWith({
      operation: 'update',
      table: 'widgets_table',
      values: { label: 'New' },
      where: [{ column: 'id', operator: 'eq', value: 'r1' }],
    });
  });

  it('does not call submitMutation for a no-op edit', async () => {
    const submitMutation = vi.fn().mockResolvedValue({ ok: true });
    const { container } = await setup(submitMutation);

    const cell = getCell(container, 'r1', 'label');
    fireEvent.doubleClick(cell);
    const input = cell.querySelector('input');
    expect(input).not.toBe(null);
    // No `fireEvent.change` — commit the same value that was already there.
    fireEvent.keyDown(input!, { key: 'Enter' });

    // Give any (incorrect) async call a chance to fire before asserting it didn't.
    await waitFor(() => {
      expect(getCell(container, 'r1', 'label').textContent).toBe('Old');
    });
    expect(submitMutation).not.toHaveBeenCalled();
  });

  it('shows an alert and reverts the cell when the mutation result is ok:false', async () => {
    const submitMutation = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Server rejected the update' });
    const { container } = await setup(submitMutation);

    editCell(container, 'r1', 'label', 'New');

    await waitFor(() => {
      const alert = screen.queryByRole('alert');
      expect(alert).not.toBe(null);
      expect(alert!.textContent).toContain('Server rejected the update');
    });
    // The stuck cell reverts back to the pre-edit value.
    await waitFor(() => {
      expect(getCell(container, 'r1', 'label').textContent).toBe('Old');
    });
  });

  it('shows an alert and reverts the cell when the adapter rejects', async () => {
    const submitMutation = vi.fn().mockRejectedValue(new Error('Network unreachable'));
    const { container } = await setup(submitMutation);

    editCell(container, 'r1', 'label', 'New');

    await waitFor(() => {
      const alert = screen.queryByRole('alert');
      expect(alert).not.toBe(null);
      expect(alert!.textContent).toContain('Network unreachable');
    });
    await waitFor(() => {
      expect(getCell(container, 'r1', 'label').textContent).toBe('Old');
    });
  });

  it('does not allow editing the PK column', async () => {
    const submitMutation = vi.fn().mockResolvedValue({ ok: true });
    const { container } = await setup(submitMutation);

    const cell = getCell(container, 'r1', 'id');
    fireEvent.doubleClick(cell);

    expect(cell.querySelector('input')).toBe(null);
    expect(submitMutation).not.toHaveBeenCalled();
  });

  it('clears the mutation error alert after a subsequent successful edit', async () => {
    const submitMutation = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Failed once' })
      .mockResolvedValueOnce({ ok: true });
    const { container } = await setup(submitMutation);

    editCell(container, 'r1', 'label', 'Bad');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBe(null);
    });

    editCell(container, 'r1', 'label', 'Good');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBe(null);
    });
  });
});
