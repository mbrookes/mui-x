import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioDataSource } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioDataDrawer } from './StudioDataDrawer';

const { render } = createRenderer();

vi.mock('./DataSourceSection', () => ({
  DataSourceSection: () => {
    throw new Error('data source section exploded');
  },
}));

const SOURCE: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
  rows: [{ amount: 1 }],
};

// Tier1 whole-dashboard-crash fix: `StudioDataDrawer` previously had no error boundary
// anywhere in its subtree (data-source list, relationship panel, lineage graph, field
// rows), unlike `StudioComposeDrawer`/`StudioFiltersDrawer`, which self-wrap their own
// content in `StudioDrawerErrorBoundary`. A render throw from any section (e.g. a data
// source section reached through a hostile/malformed doc-authored source) previously had
// no boundary to stop at and unmounted the entire `<Studio>` tree.
describe('<StudioDataDrawer /> error boundary (Tier1 whole-dashboard-crash fix)', () => {
  it('contains a render throw from a data-source section instead of crashing the whole render tree', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { wrapper } = createStudioHarness({
      initialState: {
        runtime: { dataSources: { orders: SOURCE } },
      },
    });

    expect(() =>
      render(
        <div>
          <div data-testid="sibling">Canary content outside the drawer</div>
          <StudioDataDrawer />
        </div>,
        { wrapper },
      ),
    ).not.toThrow();

    // The sibling survives — without the boundary, React would have unmounted the whole
    // render tree (nothing in it would catch the throw), taking the sibling down with it.
    expect(screen.getByTestId('sibling')).not.toBe(null);
    // `StudioDrawerErrorBoundary` renders the thrown error's own message.
    expect(screen.getByText('data source section exploded')).not.toBe(null);

    errorSpy.mockRestore();
  });
});
