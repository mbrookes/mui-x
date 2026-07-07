import { createRenderer, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { CrossFilterModeSection } from './CrossFilterModeSection';

const controller = {
  updateWidgetConfig: vi.fn(),
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

describe('CrossFilterModeSection', () => {
  beforeEach(() => {
    configureStudioContextMock({ getState: () => ({}), controller });
    controller.updateWidgetConfig.mockClear();
  });

  it('renders only the given modes, in order', () => {
    render(
      <CrossFilterModeSection
        widgetId="widget-1"
        title="Interactions"
        modes={['cross-filter', 'none']}
        defaultMode="none"
        value={undefined}
      />,
    );

    expect(screen.getByRole('button', { name: 'Filter' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'None' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Highlight' })).toBeNull();
  });

  it('displays defaultMode selected when the stored value is undefined', () => {
    render(
      <CrossFilterModeSection
        widgetId="widget-1"
        title="Interactions"
        modes={['cross-highlight', 'cross-filter', 'none']}
        defaultMode="cross-highlight"
        value={undefined}
      />,
    );

    expect(screen.getByRole('button', { name: 'Highlight', pressed: true })).toBeVisible();
  });

  it('passes through a stored value that is in `modes`', () => {
    render(
      <CrossFilterModeSection
        widgetId="widget-1"
        title="Interactions"
        modes={['cross-highlight', 'cross-filter', 'none']}
        defaultMode="cross-highlight"
        value="none"
      />,
    );

    expect(screen.getByRole('button', { name: 'None', pressed: true })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Highlight', pressed: false })).toBeVisible();
  });

  it('coerces a legacy cross-highlight value to cross-filter when Highlight is not offered', () => {
    render(
      <CrossFilterModeSection
        widgetId="widget-1"
        title="Interactions"
        modes={['cross-filter', 'none']}
        defaultMode="none"
        value="cross-highlight"
      />,
    );

    expect(screen.getByRole('button', { name: 'Filter', pressed: true })).toBeVisible();
  });

  it('commits defaultMode when the selected toggle is deselected (null onChange value)', async () => {
    const { user } = render(
      <CrossFilterModeSection
        widgetId="widget-1"
        title="Interactions"
        modes={['cross-highlight', 'cross-filter', 'none']}
        defaultMode="cross-highlight"
        value="cross-filter"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      crossFilterMode: 'cross-highlight',
    });
  });

  it('commits the clicked mode when selecting a different button', async () => {
    const { user } = render(
      <CrossFilterModeSection
        widgetId="widget-1"
        title="Interactions"
        modes={['cross-highlight', 'cross-filter', 'none']}
        defaultMode="cross-highlight"
        value="cross-highlight"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'None' }));

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      crossFilterMode: 'none',
    });
  });
});
