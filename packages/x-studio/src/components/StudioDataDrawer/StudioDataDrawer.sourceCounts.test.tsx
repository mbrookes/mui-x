import * as React from 'react';
import { act, createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioDataSource } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioDataDrawer } from './StudioDataDrawer';

const { render } = createRenderer();

// H1: the preview/lineage dialog titles read `source.rows?.length ?? 0`, which reported a
// confident "0 rows" for every adapter-backed source. `rows` stays `undefined` on such a source
// until the host imperatively calls `setDataSourceRows` — the adapter path resolves rows
// per-widget into `studioRequestCache` and never writes them back here — so that `0` was a count
// nobody had taken.
//
// This lives in its own file because `StudioDataDrawer.test.tsx` mocks `DataSourceSection` to
// throw, which is incompatible with driving the drawer's real preview flow.
const ADAPTER_SOURCE: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'amount', label: 'Amount', type: 'number' },
    { id: 'region', label: 'Region', type: 'string' },
  ],
  adapter: { getRows: async () => ({ rows: [] }) },
};

function openPreviewDialog(source: StudioDataSource) {
  const { wrapper } = createStudioHarness({
    initialState: { runtime: { dataSources: { [source.id]: source } } },
  });
  render(<StudioDataDrawer />, { wrapper });

  // "View source data" lives inside the source header's preview tooltip, which opens on focus.
  // With a single source it is the only entry point to the preview dialog.
  act(() => {
    screen.getByRole('button', { name: /Orders/ }).focus();
  });
  act(() => {
    screen.getByRole('button', { name: /View source data/i }).click();
  });
}

describe('StudioDataDrawer source counts (H1)', () => {
  it('does not report "0 rows" in the preview dialog title for an unfetched adapter source', () => {
    openPreviewDialog(ADAPTER_SOURCE);

    const title = screen.getByRole('dialog');
    expect(title.textContent).not.toMatch(/0 rows/);
    expect(title.textContent).toMatch(/Loading/);
    expect(title.textContent).toMatch(/2 fields/);
  });

  it('shows a loading state rather than "No data available" in the preview body', () => {
    openPreviewDialog(ADAPTER_SOURCE);

    expect(screen.queryByText(/No data available for Orders/)).toBe(null);
    expect(screen.getAllByText('Loading').length).toBeGreaterThan(0);
  });

  it('still reports "0 rows" and "no data" when the source genuinely delivered an empty set', () => {
    openPreviewDialog({ ...ADAPTER_SOURCE, rows: [] });

    expect(screen.getByRole('dialog').textContent).toMatch(/0 rows/);
    // Two sites say it: the source-header preview tooltip and the dialog body.
    expect(screen.getAllByText(/No data available for Orders/).length).toBeGreaterThan(0);
  });
});
