import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import {
  StudioWidgetCardActionsOverlay,
  type StudioWidgetCardActionsOverlayProps,
} from './StudioWidgetCardActionsOverlay';

const { render } = createRenderer();

function setup(overrides: Partial<StudioWidgetCardActionsOverlayProps> = {}) {
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
    exportLabel: 'Export CSV',
    showEditActions: true,
    showViewExport: false,
    showViewExpand: false,
    overlayTopSx: {},
    moveToPageOptions: [],
    ...handlers,
    ...overrides,
  };
  const { wrapper } = createStudioHarness();
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
});
