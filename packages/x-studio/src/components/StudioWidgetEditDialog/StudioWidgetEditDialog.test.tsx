import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioCustomWidgetDef, StudioWidget, StudioWidgetConfig } from '../../models';
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

function customWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'acme-alert',
    title: 'My Alert',
    config: {} as StudioWidgetConfig,
    ...overrides,
  };
}

const CUSTOM_WIDGET_DEF: StudioCustomWidgetDef = {
  kind: 'acme-alert',
  label: 'Alert Banner',
  component: () => <div data-testid="custom-widget-preview">Custom preview</div>,
  setupPanel: ({ widgetId }) => (
    <div data-testid="custom-setup-panel">Custom setup for {widgetId}</div>
  ),
};

function chartWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'chart',
    title: 'My Chart',
    sourceId: 'src',
    config: { chartType: 'bar', xField: 'region' } as StudioWidgetConfig,
    ...overrides,
  };
}

const CHART_SOURCE = {
  id: 'src',
  label: 'Sales',
  fields: [{ id: 'region', label: 'Region', type: 'string' as const }],
  rows: [],
};

function setup(
  options: {
    widgets?: Record<string, StudioWidget>;
    widgetId?: string;
    open?: boolean;
    featureFlags?: Record<string, boolean>;
    dataSources?: Record<string, typeof CHART_SOURCE>;
    customWidgets?: StudioCustomWidgetDef[];
    /** Omit the `children` override so the dialog renders its default Setup-tab dispatch. */
    withoutChildren?: boolean;
  } = {},
) {
  const onClose = vi.fn();
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      widgets: options.widgets ?? { w1: textWidget() },
      ...(options.dataSources ? { dataSources: options.dataSources } : {}),
    },
    providerProps:
      options.featureFlags || options.customWidgets
        ? { featureFlags: options.featureFlags, customWidgets: options.customWidgets }
        : undefined,
  });
  const view = render(
    // Pass children to bypass the heavy auto-rendered widget preview (unless the test
    // needs the dialog's own default dispatch, e.g. the Setup-tab custom-widget test).
    <StudioWidgetEditDialog
      open={options.open ?? true}
      onClose={onClose}
      widgetId={options.widgetId ?? 'w1'}
    >
      {options.withoutChildren ? undefined : <div data-testid="preview" />}
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

  it('shows Setup, Filters and Format tabs for a data-backed widget', () => {
    setup({ widgets: { w1: chartWidget() }, dataSources: { src: CHART_SOURCE } });
    expect(screen.getByRole('tab', { name: 'Setup' })).not.toBe(null);
    expect(screen.getByRole('tab', { name: 'Filters' })).not.toBe(null);
    expect(screen.getByRole('tab', { name: 'Format' })).not.toBe(null);
  });

  it('hides the Filters tab for text widgets', () => {
    setup();
    expect(screen.queryByRole('tab', { name: 'Filters' })).toBe(null);
    expect(screen.getByRole('tab', { name: 'Setup' })).not.toBe(null);
    expect(screen.getByRole('tab', { name: 'Format' })).not.toBe(null);
  });

  it('hides the Filters tab when the widgetFilters feature is disabled', () => {
    setup({
      widgets: { w1: chartWidget() },
      dataSources: { src: CHART_SOURCE },
      featureFlags: { widgetFilters: false },
    });
    expect(screen.queryByRole('tab', { name: 'Filters' })).toBe(null);
    expect(screen.getByRole('tab', { name: 'Setup' })).not.toBe(null);
    expect(screen.getByRole('tab', { name: 'Format' })).not.toBe(null);
  });

  // Regression test for the architecture-review bug: editing a custom widget via the
  // built-in edit dialog previously rendered a blank Setup tab (no custom-widget handling
  // at all) even though the preview rendered fine via `customDef.component`. Both the
  // Setup tab and the preview now resolve through the same unified widget-kind registry.
  it("renders a custom widget kind's setupPanel in the Setup tab (previously blank)", () => {
    setup({
      widgets: { w1: customWidget() },
      customWidgets: [CUSTOM_WIDGET_DEF],
      withoutChildren: true,
    });
    expect(screen.getByTestId('custom-setup-panel').textContent).toBe('Custom setup for w1');
  });

  it("renders the custom widget's own preview component alongside the fixed Setup tab", () => {
    setup({
      widgets: { w1: customWidget() },
      customWidgets: [CUSTOM_WIDGET_DEF],
      withoutChildren: true,
    });
    expect(screen.getByTestId('custom-widget-preview')).not.toBe(null);
    expect(screen.getByTestId('custom-setup-panel')).not.toBe(null);
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
