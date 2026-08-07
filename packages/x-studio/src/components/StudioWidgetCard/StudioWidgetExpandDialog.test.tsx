import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { createTheme } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import type { StudioWidgetDef } from '../../internals/StudioUIConfigContext';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioWidgetExpandDialog } from './StudioWidgetExpandDialog';
import * as widgetUtils from '../../internals/widgetPresentation';

const { render } = createRenderer();

vi.mock('../../internals/widgetPresentation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../internals/widgetPresentation')>()),
  exportChartToPng: vi.fn(),
}));

function widget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'chart',
    title: 'Sales',
    config: {} as StudioWidgetConfig,
    ...overrides,
  };
}

const fakeDef = {
  component: () => <div data-testid="chart-stub" />,
  capabilities: { export: 'png', expand: true },
} as unknown as StudioWidgetDef;

describe('StudioWidgetExpandDialog', () => {
  // Regression coverage: the expanded-dialog PNG export used to call
  // `exportChartToPng(widget, container)` without a `backgroundColor`, unlike the
  // card's inline chart export (`exportChartToPng(widget, container, theme.palette
  // .background.default)`), so PNGs exported from the expanded view lost the theme
  // background. Extracting the dialog into its own component with its own `useTheme()`
  // structurally fixes this — assert the third argument is now always passed.
  it('passes the theme background color as the PNG export backgroundColor', () => {
    vi.mocked(widgetUtils.exportChartToPng).mockClear();
    const w = widget();
    const { wrapper } = createStudioHarness({
      initialState: { doc: { widgets: { [w.id]: w } } },
    });

    render(
      <StudioWidgetExpandDialog
        open
        onClose={() => {}}
        widget={w}
        def={fakeDef}
        dataSource={undefined}
        pageId="page-1"
        effectiveSubtitle=""
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download expanded chart as PNG' }));

    expect(widgetUtils.exportChartToPng).toHaveBeenCalledTimes(1);
    const call = vi.mocked(widgetUtils.exportChartToPng).mock.calls[0];
    expect(call[0]).toBe(w);
    expect(call[2]).toBe(createTheme().palette.background.default);
  });

  // Tier1 whole-dashboard-crash fix: this fullscreen "expand" view renders `def.component`
  // unprotected — the same widget renderer the canvas card wraps in
  // `StudioWidgetErrorBoundary` — but previously had no boundary of its own. A render throw
  // here (e.g. a not-yet-hardened chart edge case) unmounted the whole `<Studio>` tree
  // instead of being contained to the dialog.
  it('contains a render throw from the widget renderer instead of crashing the whole render tree', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = widget();
    const { wrapper } = createStudioHarness({
      initialState: { doc: { widgets: { [w.id]: w } } },
    });
    const throwingDef = {
      component: () => {
        throw new Error('expanded chart exploded');
      },
      capabilities: { export: 'png', expand: true },
    } as unknown as StudioWidgetDef;

    expect(() =>
      render(
        <div>
          <div data-testid="sibling">Canary content outside the dialog</div>
          <StudioWidgetExpandDialog
            open
            onClose={() => {}}
            widget={w}
            def={throwingDef}
            dataSource={undefined}
            pageId="page-1"
            effectiveSubtitle=""
          />
        </div>,
        { wrapper },
      ),
    ).not.toThrow();

    // The sibling survives — without the boundary, React would have unmounted the whole
    // render tree (nothing in it would catch the throw), taking the sibling down with it.
    expect(screen.getByTestId('sibling')).not.toBe(null);
    // The dialog's own title still renders — only the widget content is contained.
    expect(screen.getByText('Sales')).not.toBe(null);
    // `StudioWidgetErrorBoundary` renders the thrown error's own message.
    expect(screen.getByText('expanded chart exploded')).not.toBe(null);

    errorSpy.mockRestore();
  });
});
