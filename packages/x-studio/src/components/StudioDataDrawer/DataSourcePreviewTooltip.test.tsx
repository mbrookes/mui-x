import * as React from 'react';
import { act, createRenderer, fireEvent, screen, waitFor } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioDataSource } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import DataSourcePreviewTooltip from './DataSourcePreviewTooltip';

const { render } = createRenderer();

const SOURCE: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'id', label: 'ID', type: 'string' },
    { id: 'total', label: 'Total', type: 'number' },
  ],
  rows: [
    { id: 'a', total: 1 },
    { id: 'b', total: 2 },
  ],
};

function setup(onOpenPreview?: (sourceId: string) => void) {
  const { wrapper } = createStudioHarness();
  return render(
    <DataSourcePreviewTooltip source={SOURCE} onOpenPreview={onOpenPreview}>
      <button type="button">Orders</button>
    </DataSourcePreviewTooltip>,
    { wrapper },
  );
}

describe('DataSourcePreviewTooltip', () => {
  it('renders the trigger untouched when the source has no rows and no preview action', () => {
    const { wrapper } = createStudioHarness();
    render(
      <DataSourcePreviewTooltip source={{ ...SOURCE, rows: [] }}>
        <button type="button">Orders</button>
      </DataSourcePreviewTooltip>,
      { wrapper },
    );

    expect(screen.getByRole('button', { name: 'Orders' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /View source data/i })).toBe(null);
  });

  // ── H1: an adapter-backed source has never delivered its rows ──────────────
  //
  // `rows === undefined` used to drop the whole tooltip — which also removed the ONLY keyboard
  // route to "View source data", since `StudioDataDrawer` gates its "View lineage" entry point on
  // two or more sources.
  describe('adapter-backed source with undefined rows (H1)', () => {
    const ADAPTER_SOURCE: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: SOURCE.fields,
      adapter: { getRows: async () => ({ rows: [] }) },
    };

    it('keeps the "View source" affordance reachable and says the rows are still loading', () => {
      const { wrapper } = createStudioHarness();
      render(
        <DataSourcePreviewTooltip source={ADAPTER_SOURCE} onOpenPreview={() => {}}>
          <button type="button">Orders</button>
        </DataSourcePreviewTooltip>,
        { wrapper },
      );

      act(() => {
        screen.getByRole('button', { name: 'Orders' }).focus();
      });

      expect(screen.getByRole('button', { name: /View source data/i })).toBeVisible();
      expect(screen.getByText('Loading')).toBeVisible();
      // Never a fabricated row count for rows nobody read.
      expect(screen.queryByText(/more rows/i)).toBe(null);
    });
  });

  // ── M11: the preview action must be reachable without a mouse ───────────────
  //
  // "View source data →" lives inside the hover tooltip, which was portaled to the end of
  // `<body>` (so Tab from the trigger never reached it) and closed on focus-out anyway. With
  // a single data source the preview dialog has no other entry point — `StudioDataDrawer`
  // gates "View lineage" on `sourceList.length >= 2` — so the whole feature was mouse-only.
  describe('keyboard reachability (M11)', () => {
    it('opens the tooltip when the trigger receives focus', () => {
      setup(() => {});

      act(() => {
        screen.getByRole('button', { name: 'Orders' }).focus();
      });

      expect(screen.getByRole('button', { name: /View source data/i })).not.toBe(null);
    });

    it('keeps the tooltip open while focus moves onto the "View source" button', async () => {
      setup(() => {});

      const trigger = screen.getByRole('button', { name: 'Orders' });
      act(() => {
        trigger.focus();
      });
      const viewSource = screen.getByRole('button', { name: /View source data/i });

      // Focus moves from the trigger into the tooltip — the tooltip must survive it.
      // `focusOut`, not `blur`: the wrapper closes on React's `onBlur`, which React binds to
      // the BUBBLING native `focusout`. A plain `blur` event does not bubble, so it never
      // reaches the wrapper and the assertion below would pass without exercising anything.
      fireEvent.focusOut(trigger, { relatedTarget: viewSource });
      act(() => {
        viewSource.focus();
      });

      // A SYNCHRONOUS assertion here could not fail: the popper unmounts only at the END of MUI's
      // Grow exit transition (that is exactly why the sibling "closes the tooltip …" test below
      // needs `waitFor`), so it is still in the tree for a frame even when `open` HAS flipped to
      // false. Waiting past the exit window first is what makes this assert the settled state
      // instead of a transitional frame.
      //
      // What this test does NOT pin, verified by mutation: neither `disablePortal` nor the
      // wrapper's `onBlur` containment check changes the outcome here. React propagates events
      // through the REACT tree, so even a portaled "View source" button's focus bubbles back to
      // this wrapper's `onFocus`, which re-opens the tooltip in the same batch that the blur
      // closed it. Those two lines in the component are kept as defense in depth (they avoid a
      // close/re-open round trip and keep DOM tab order matching visual order) but they are not
      // observable from here. What IS pinned is the user-facing guarantee: after focus lands on
      // the button, the button is still there to be activated.
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
      });

      expect(screen.getByRole('button', { name: /View source data/i })).toBeVisible();
    });

    it('invokes onOpenPreview when the "View source" button is activated', () => {
      const onOpenPreview = vi.fn();
      setup(onOpenPreview);

      act(() => {
        screen.getByRole('button', { name: 'Orders' }).focus();
      });
      fireEvent.click(screen.getByRole('button', { name: /View source data/i }));

      expect(onOpenPreview).toHaveBeenCalledWith('orders');
    });

    it('closes the tooltip when focus leaves the trigger and the tooltip entirely', async () => {
      setup(() => {});

      const trigger = screen.getByRole('button', { name: 'Orders' });
      act(() => {
        trigger.focus();
      });
      expect(screen.queryByRole('button', { name: /View source data/i })).not.toBe(null);

      fireEvent.focusOut(trigger, { relatedTarget: document.body });

      // `waitFor`, not a synchronous assertion: the popper unmounts at the END of MUI's Grow
      // exit transition, so it is still in the tree for a frame after `open` flips to false.
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /View source data/i })).toBe(null);
      });
    });

    it('renders no "View source" affordance when the host supplies no handler', () => {
      setup(undefined);

      act(() => {
        screen.getByRole('button', { name: 'Orders' }).focus();
      });

      expect(screen.queryByRole('button', { name: /View source data/i })).toBe(null);
    });
  });
});
