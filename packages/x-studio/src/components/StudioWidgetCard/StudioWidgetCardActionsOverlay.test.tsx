import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioLocaleText } from '@mui/x-studio-core/engine';
import { frLocaleText } from '@mui/x-studio-core/locales';
import { createStudioHarness } from '../../internals/test-utils';
import {
  StudioWidgetCardActionsOverlay,
  type StudioWidgetCardActionsOverlayProps,
} from './StudioWidgetCardActionsOverlay';

const { render } = createRenderer();

function setup(
  overrides: Partial<StudioWidgetCardActionsOverlayProps> = {},
  localeText?: Partial<StudioLocaleText>,
) {
  const handlers = {
    onExport: vi.fn(),
    onExpand: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onMoveToPage: vi.fn(),
  };
  const props: StudioWidgetCardActionsOverlayProps = {
    mode: 'edit',
    canExport: false,
    isChart: false,
    canExpand: false,
    exportLabel: 'Export CSV',
    showEditActions: true,
    showViewExport: false,
    showViewExpand: false,
    overlayTopSx: {},
    moveToPageOptions: [],
    ...handlers,
    ...overrides,
  };
  const { wrapper } = createStudioHarness({ providerProps: { localeText } });
  const view = render(<StudioWidgetCardActionsOverlay {...props} />, { wrapper });
  return { ...view, ...handlers };
}

describe('StudioWidgetCardActionsOverlay — edit mode', () => {
  it('renders edit, duplicate and delete actions', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Edit widget' })).not.toBe(null);
    expect(screen.getByRole('button', { name: 'Duplicate widget' })).not.toBe(null);
    expect(screen.getByRole('button', { name: 'Delete widget' })).not.toBe(null);
  });

  it('calls onEdit and onDuplicate from their buttons', async () => {
    const { user, onEdit, onDuplicate } = setup();
    await user.click(screen.getByRole('button', { name: 'Edit widget' }));
    await user.click(screen.getByRole('button', { name: 'Duplicate widget' }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onDuplicate).toHaveBeenCalledOnce();
  });

  it('confirms before deleting: opens a dialog, deletes only on confirm', async () => {
    const { user, onDelete } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete widget' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Delete widget?')).not.toBe(null);
    await user.click(screen.getByRole('button', { name: 'Delete' })); // dialog confirm
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('does not delete when the confirmation is cancelled', async () => {
    const { user, onDelete } = setup();
    await user.click(screen.getByRole('button', { name: 'Delete widget' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('shows the export action and calls onExport when exportable', async () => {
    const { user, onExport } = setup({ canExport: true });
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('moves the widget to a chosen page from the move menu', async () => {
    const { user, onMoveToPage } = setup({
      moveToPageOptions: [{ id: 'p2', title: 'Page 2' }],
    });
    await user.click(screen.getByRole('button', { name: 'Move to page' }));
    await user.click(screen.getByRole('menuitem', { name: 'Page 2' }));
    expect(onMoveToPage).toHaveBeenCalledWith('p2');
  });

  it('requests an insight type from the insight menu', async () => {
    const onInsightRequest = vi.fn();
    const { user } = setup({ onInsightRequest });
    await user.click(screen.getByRole('button', { name: 'AI insight' }));
    await user.click(screen.getByRole('menuitem', { name: 'Summary' }));
    expect(onInsightRequest).toHaveBeenCalledWith('summary');
  });

  it('hides the forecast insight item for widgets that do not support forecasting', async () => {
    const { user } = setup({ onInsightRequest: vi.fn(), supportsForecast: false });
    await user.click(screen.getByRole('button', { name: 'AI insight' }));
    expect(screen.getByRole('menuitem', { name: 'Summary' })).not.toBe(null);
    expect(screen.getByRole('menuitem', { name: 'Analysis' })).not.toBe(null);
    expect(screen.queryByRole('menuitem', { name: 'Forecast' })).toBe(null);
  });

  it('shows the forecast insight item when the widget supports forecasting', async () => {
    const onInsightRequest = vi.fn();
    const { user } = setup({ onInsightRequest, supportsForecast: true });
    await user.click(screen.getByRole('button', { name: 'AI insight' }));
    await user.click(screen.getByRole('menuitem', { name: 'Forecast' }));
    expect(onInsightRequest).toHaveBeenCalledWith('forecast');
  });

  it('shows the AI-refresh action with the default tooltip/aria-label', async () => {
    const onAiRefresh = vi.fn();
    const { user } = setup({ onAiRefresh });
    await user.click(screen.getByRole('button', { name: 'Refresh AI content' }));
    expect(onAiRefresh).toHaveBeenCalledOnce();
  });

  it('localizes the AI-refresh tooltip/aria-label instead of hardcoding English', () => {
    setup({ onAiRefresh: vi.fn() }, frLocaleText);
    expect(screen.getByRole('button', { name: frLocaleText.widgetAiRefreshTooltip })).not.toBe(
      null,
    );
    expect(screen.queryByRole('button', { name: 'Refresh AI content' })).toBe(null);
  });

  it('localizes the insight-type menu item labels instead of hardcoding capitalized English', async () => {
    const { user } = setup({ onInsightRequest: vi.fn(), supportsForecast: true }, frLocaleText);
    await user.click(screen.getByRole('button', { name: frLocaleText.widgetAiInsightTooltip }));
    expect(screen.getByRole('menuitem', { name: frLocaleText.widgetInsightTypeSummary })).not.toBe(
      null,
    );
    expect(screen.getByRole('menuitem', { name: frLocaleText.widgetInsightTypeAnalysis })).not.toBe(
      null,
    );
    expect(screen.getByRole('menuitem', { name: frLocaleText.widgetInsightTypeForecast })).not.toBe(
      null,
    );
    expect(screen.queryByRole('menuitem', { name: 'Summary' })).toBe(null);
  });

  // Regression coverage for architecture-review finding 3.13: the Expand button used to
  // be gated on `isChart` alone, while the expand dialog itself (in `StudioWidgetCard`)
  // is gated on `capabilities.expand === true`. Latent today because only the chart def
  // sets `expand: true`, but a non-chart custom widget declaring the capability got a
  // dialog with no button to open it, and (in principle) a chart widget without the
  // capability would show a button that does nothing.
  describe('Expand button gating (finding 3.13)', () => {
    it('shows the Expand button for a non-chart widget that declares capabilities.expand', async () => {
      const { user, onExpand } = setup({ isChart: false, canExpand: true });
      await user.click(screen.getByRole('button', { name: 'Expand widget' }));
      expect(onExpand).toHaveBeenCalledOnce();
    });

    it('hides the Expand button for a chart widget without capabilities.expand', () => {
      setup({ isChart: true, canExpand: false });
      expect(screen.queryByRole('button', { name: 'Expand widget' })).toBe(null);
    });
  });
});

describe('StudioWidgetCardActionsOverlay — view mode', () => {
  it('renders nothing when there are no view actions', () => {
    setup({ mode: 'view' });
    expect(screen.queryByRole('button')).toBe(null);
  });

  it('shows the export action in view mode when exportable', () => {
    setup({ mode: 'view', canExport: true, showViewExport: true });
    expect(screen.getByRole('button', { name: 'Export CSV' })).not.toBe(null);
  });

  it('keeps the toolbar hidden when an AI-enabled widget is not hovered/selected', () => {
    setup({ mode: 'view', onInsightRequest: vi.fn(), showViewActions: false });
    const overlay = document.querySelector('[data-widget-overlay]');
    expect(overlay).not.toBe(null);
    expect(getComputedStyle(overlay as Element).visibility).toBe('hidden');
  });

  it('reveals the toolbar when the widget is hovered/selected', () => {
    setup({ mode: 'view', onInsightRequest: vi.fn(), showViewActions: true });
    const overlay = document.querySelector('[data-widget-overlay]');
    expect(getComputedStyle(overlay as Element).visibility).toBe('visible');
  });
});
