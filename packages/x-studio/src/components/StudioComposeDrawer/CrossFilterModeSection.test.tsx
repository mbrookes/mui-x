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

  // Regression for finding 2.8 (Tier3 #8): deselecting the already-default-mode button used
  // to still commit `crossFilterMode: defaultMode` as a NEW config key even though nothing
  // visually changes (the button was already showing as selected because `value` was
  // `undefined`, resolved to `defaultMode`) — an undoable no-op that clutters the undo stack.
  describe('no-op guard on deselect (finding 2.8)', () => {
    it('does not commit when deselecting the default button while value is undefined', async () => {
      const { user } = render(
        <CrossFilterModeSection
          widgetId="widget-1"
          title="Interactions"
          modes={['cross-highlight', 'cross-filter', 'none']}
          defaultMode="none"
          value={undefined}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'None' }));

      expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    });

    it('does not commit when deselecting a button whose value already equals defaultMode explicitly', async () => {
      const { user } = render(
        <CrossFilterModeSection
          widgetId="widget-1"
          title="Interactions"
          modes={['cross-highlight', 'cross-filter', 'none']}
          defaultMode="none"
          value="none"
        />,
      );

      await user.click(screen.getByRole('button', { name: 'None' }));

      expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    });

    it('still commits when deselecting a NON-default selected mode (the resolved value actually changes)', async () => {
      // This is the pre-existing "commits defaultMode when deselected" case (still correct):
      // the resolved next value differs from the currently stored value, so it's a real change.
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
  });
});
