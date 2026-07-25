import * as React from 'react';
import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
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
  it('renders the trigger untouched when the source has no rows', () => {
    const { wrapper } = createStudioHarness();
    render(
      <DataSourcePreviewTooltip source={{ ...SOURCE, rows: [] }}>
        <button type="button">Orders</button>
      </DataSourcePreviewTooltip>,
      { wrapper },
    );

    expect(screen.getByRole('button', { name: 'Orders' })).not.toBe(null);
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

    it('keeps the tooltip open while focus moves onto the "View source" button', () => {
      setup(() => {});

      const trigger = screen.getByRole('button', { name: 'Orders' });
      act(() => {
        trigger.focus();
      });
      const viewSource = screen.getByRole('button', { name: /View source data/i });

      // Focus moves from the trigger into the tooltip — the tooltip must survive it.
      fireEvent.blur(trigger, { relatedTarget: viewSource });
      act(() => {
        viewSource.focus();
      });

      expect(screen.getByRole('button', { name: /View source data/i })).not.toBe(null);
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

    it('closes the tooltip when focus leaves the trigger and the tooltip entirely', () => {
      setup(() => {});

      const trigger = screen.getByRole('button', { name: 'Orders' });
      act(() => {
        trigger.focus();
      });
      expect(screen.queryByRole('button', { name: /View source data/i })).not.toBe(null);

      fireEvent.blur(trigger, { relatedTarget: document.body });

      expect(screen.queryByRole('button', { name: /View source data/i })).toBe(null);
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
