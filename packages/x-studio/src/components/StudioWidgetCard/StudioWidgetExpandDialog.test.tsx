import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { createTheme } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import type { StudioWidgetDef } from '../../internals/StudioUIConfigContext';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioWidgetExpandDialog } from './StudioWidgetExpandDialog';
import * as widgetUtils from '../../internals/widgetUtils';

const { render } = createRenderer();

vi.mock('../../internals/widgetUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../internals/widgetUtils')>()),
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
});
