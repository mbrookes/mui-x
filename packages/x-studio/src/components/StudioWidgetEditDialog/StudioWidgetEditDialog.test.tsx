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

function throwingPreviewWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'acme-throw-preview',
    title: 'Bad Preview Widget',
    config: {} as StudioWidgetConfig,
    ...overrides,
  };
}

const THROWING_PREVIEW_WIDGET_DEF: StudioCustomWidgetDef = {
  kind: 'acme-throw-preview',
  label: 'Throws in preview',
  component: () => {
    throw new Error('widget preview exploded');
  },
  setupPanel: () => <div data-testid="setup-panel-ok">Setup ok</div>,
};

function throwingSetupWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'acme-throw-setup',
    title: 'Bad Setup Widget',
    config: {} as StudioWidgetConfig,
    ...overrides,
  };
}

const THROWING_SETUP_WIDGET_DEF: StudioCustomWidgetDef = {
  kind: 'acme-throw-setup',
  label: 'Throws in setup',
  component: () => <div data-testid="preview-ok">Preview ok</div>,
  setupPanel: () => {
    throw new Error('setup panel exploded');
  },
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
      doc: {
        widgets: options.widgets ?? { w1: textWidget() },
      },
      ...(options.dataSources ? { runtime: { dataSources: options.dataSources } } : {}),
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

  it('hides the Filters tab for filter widgets (H4)', () => {
    // H4: `builtinWidgetDefs` declared the filter kind as `widgetFilters: true`, so this tab
    // rendered — but `StudioFilterWidget` deliberately never routes through
    // `useWidgetRows`/`selectFiltersForWidget` (it reads rows straight from
    // `getCachedNormalizedDataSource`), so a widget-scoped filter on one is evaluated by
    // nothing. The filters drawer then hid it too, making it unreachable to remove.
    setup({
      widgets: {
        w1: {
          id: 'w1',
          kind: 'filter',
          title: 'Region picker',
          sourceId: 'src',
          config: {
            filterWidgetField: 'region',
            filterWidgetType: 'multi-select',
          } as StudioWidgetConfig,
        },
      },
      dataSources: { src: CHART_SOURCE },
    });
    expect(screen.queryByRole('tab', { name: 'Filters' })).toBe(null);
    expect(screen.getByRole('tab', { name: 'Setup' })).not.toBe(null);
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

// Tier1 whole-dashboard-crash fix: this dialog renders `BuiltinWidgetPreview` (which
// itself renders `def.component` — the same widget renderer the canvas card wraps in
// `StudioWidgetErrorBoundary`) and `def.setupPanel`/`WidgetFiltersPanel`/`FormatPanel`/
// `TextFormatPanel` (the same class of content `StudioComposeDrawer`'s `WidgetConfigView`
// wraps in `StudioDrawerErrorBoundary`), but previously had no boundary of its own. A
// render throw in either (a not-yet-hardened chart edge case, or any third-party
// `customWidgets` component) unmounted the whole `<Studio>` tree instead of being contained
// to the dialog.
describe('StudioWidgetEditDialog error boundaries (Tier1 whole-dashboard-crash fix)', () => {
  it('contains a render throw from the widget preview instead of crashing the whole render tree', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setup({
      widgets: { w1: throwingPreviewWidget() },
      customWidgets: [THROWING_PREVIEW_WIDGET_DEF],
      withoutChildren: true,
    });

    // The Setup tab (a sibling surface within the same dialog) still renders fine —
    // the throw is contained to the preview panel, not the whole dialog.
    expect(screen.getByTestId('setup-panel-ok')).not.toBe(null);
    // `StudioWidgetErrorBoundary` renders the thrown error's own message.
    expect(screen.getByText('widget preview exploded')).not.toBe(null);

    errorSpy.mockRestore();
  });

  it('contains a render throw from a widget setup panel instead of crashing the whole render tree', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setup({
      widgets: { w1: throwingSetupWidget() },
      customWidgets: [THROWING_SETUP_WIDGET_DEF],
    });

    // The preview panel (rendered via the `children` override in this test's `setup()`)
    // still renders fine — the throw is contained to the Setup tab, not the whole dialog.
    expect(screen.getByTestId('preview')).not.toBe(null);
    // `StudioDrawerErrorBoundary` renders the thrown error's own message.
    expect(screen.getByText('setup panel exploded')).not.toBe(null);

    errorSpy.mockRestore();
  });
});

// M11 (a11y): the tabs carried no `id`/`aria-controls` and the tab panels no
// `id`/`aria-labelledby`/`tabIndex`, so assistive tech could not associate a tab with its
// panel, and a scrollable panel whose content has no focusable child was unreachable by
// keyboard entirely (WCAG 2.1.1). Mirrors `Studio/TabbedSidebar.tsx`.
describe('StudioWidgetEditDialog tab/panel wiring (M11)', () => {
  it('associates every tab with its own panel', () => {
    setup({ widgets: { w1: chartWidget() }, dataSources: { src: CHART_SOURCE } });
    ['Setup', 'Filters', 'Format'].forEach((name) => {
      const tab = screen.getByRole('tab', { name });
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      const panel = document.getElementById(panelId!);
      expect(panel).not.toBe(null);
      expect(panel!.getAttribute('role')).toBe('tabpanel');
      expect(panel!.getAttribute('aria-labelledby')).toBe(tab.id);
    });
  });

  it('gives the selected panel its own tab stop', () => {
    setup({ widgets: { w1: chartWidget() }, dataSources: { src: CHART_SOURCE } });
    const setupTab = screen.getByRole('tab', { name: 'Setup' });
    const selectedPanel = document.getElementById(setupTab.getAttribute('aria-controls')!);
    expect(selectedPanel!.getAttribute('tabindex')).toBe('0');
    // Hidden panels must not add stray tab stops.
    const formatTab = screen.getByRole('tab', { name: 'Format' });
    const hiddenPanel = document.getElementById(formatTab.getAttribute('aria-controls')!);
    expect(hiddenPanel!.hasAttribute('tabindex')).toBe(false);
  });
});

/**
 * `widget.kind` is doc/AI-authored and `StudioWidgetKind` is open, so
 * `widgetKindLabels[widget.kind]` on `"toString"` resolves the inherited function — truthy,
 * so `?? widget.kind` never fires — and the dialog title rendered
 * `function toString() { [native code] } preview`. `StudioWidgetCard` already guarded this
 * exact map; the dialog now does too.
 */
describe('StudioWidgetEditDialog prototype-chain widget kind', () => {
  it('falls back to the raw kind string instead of an inherited function', () => {
    setup({ widgets: { w1: { ...textWidget(), kind: 'toString' } } });
    expect(screen.queryByText(/native code/)).toBe(null);
    expect(screen.getAllByText(/toString/).length).toBeGreaterThan(0);
  });
});
