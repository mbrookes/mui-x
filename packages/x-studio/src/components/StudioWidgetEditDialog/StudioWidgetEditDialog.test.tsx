import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioWidgetEditDialog } from './StudioWidgetEditDialog';

const { render } = createRenderer();

function textWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'text',
    title: 'My Notes',
    config: { textBody: 'hello' } as StudioWidgetConfig,
    ...overrides,
  };
}

function setup(
  options: {
    widgets?: Record<string, StudioWidget>;
    widgetId?: string;
    open?: boolean;
    featureFlags?: Record<string, boolean>;
  } = {},
) {
  const onClose = vi.fn();
  const { controller, wrapper } = createStudioHarness({
    initialState: { widgets: options.widgets ?? { w1: textWidget() } },
    providerProps: options.featureFlags ? { featureFlags: options.featureFlags } : undefined,
  });
  const view = render(
    // Pass children to bypass the heavy auto-rendered widget preview.
    <StudioWidgetEditDialog
      open={options.open ?? true}
      onClose={onClose}
      widgetId={options.widgetId ?? 'w1'}
    >
      <div data-testid="preview" />
    </StudioWidgetEditDialog>,
    { wrapper },
  );
  return { ...view, controller, onClose };
}

describe('StudioWidgetEditDialog', () => {
  it('renders nothing when the widget id is unknown', () => {
    setup({ widgetId: 'missing' });
    expect(screen.queryByRole('dialog')).toBe(null);
  });

  it('renders the widget title', () => {
    setup();
    expect(screen.getAllByText('My Notes').length).toBeGreaterThan(0);
  });

  it('shows Setup, Filters and Format tabs by default', () => {
    setup();
    expect(screen.getByRole('tab', { name: 'Setup' })).not.toBe(null);
    expect(screen.getByRole('tab', { name: 'Filters' })).not.toBe(null);
    expect(screen.getByRole('tab', { name: 'Format' })).not.toBe(null);
  });

  it('hides the Filters tab when the widgetFilters feature is disabled', () => {
    setup({ featureFlags: { widgetFilters: false } });
    expect(screen.queryByRole('tab', { name: 'Filters' })).toBe(null);
    expect(screen.getByRole('tab', { name: 'Setup' })).not.toBe(null);
    expect(screen.getByRole('tab', { name: 'Format' })).not.toBe(null);
  });

  it('calls onClose when the close button is clicked', async () => {
    const { user, onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Close edit dialog' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('selects the Format tab when clicked', async () => {
    const { user } = setup();
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveProperty('ariaSelected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Format' }));
    expect(screen.getByRole('tab', { name: 'Format' })).toHaveProperty('ariaSelected', 'true');
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveProperty('ariaSelected', 'false');
  });
});
