import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioState, StudioWidget } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioFiltersDrawer } from './StudioFiltersDrawer';

const { render } = createRenderer();

const SOURCE = {
  id: 'src',
  label: 'Sales',
  fields: [{ id: 'region', label: 'Region', type: 'string' as const }],
  rows: [],
};

function renderWithSelectedWidget(widget: StudioWidget) {
  const initialState: Partial<StudioState> = {
    dataSources: { src: SOURCE },
    widgets: { [widget.id]: widget },
    shell: {
      openDrawers: { data: false, compose: false, filters: true },
      selectedWidgetId: widget.id,
      selectedFieldId: null,
      selectedSourceId: null,
    },
  };
  const { wrapper } = createStudioHarness({
    initialState,
    // The saved-views section wraps a disabled button in a Tooltip (a known MUI dev
    // warning); disable it so the strict console check doesn't trip on unrelated noise.
    providerProps: { featureFlags: { savedFilterViews: false } },
  });
  return render(<StudioFiltersDrawer />, { wrapper });
}

describe('<StudioFiltersDrawer /> widget filter section', () => {
  it('shows the widget filter section for a chart widget', () => {
    renderWithSelectedWidget({
      id: 'chart-1',
      kind: 'chart',
      title: 'Revenue',
      sourceId: 'src',
      config: { chartType: 'bar', xField: 'region' },
    });
    expect(screen.queryByText('Widget: Revenue')).not.toBe(null);
  });

  it('hides the widget filter section for a text widget', () => {
    renderWithSelectedWidget({
      id: 'text-1',
      kind: 'text',
      title: 'Notes',
      config: {},
    });
    expect(screen.queryByText('Widget: Notes')).toBe(null);
  });
});
