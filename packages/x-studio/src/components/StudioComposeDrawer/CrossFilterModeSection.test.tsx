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

  // M16 — BEHAVIOUR CHANGE. This case previously asserted that clicking the ALREADY-SELECTED
  // button committed `defaultMode`. That mapping was user-hostile: a chart with
  // `crossFilterMode: 'none'` whose user clicked the already-highlighted **None** got
  // `'cross-highlight'` written and cross-highlighting silently switched ON — the button
  // clicked to confirm a choice changed it to something else. An exclusive
  // `ToggleButtonGroup`'s `null` is a deselect, and these modes have no "nothing selected"
  // state, so the only correct reading is "no change". Every sibling exclusive group in the
  // drawer already ignores `null`.
  it('commits nothing when the selected toggle is clicked again (null onChange value)', async () => {
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

    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Filter', pressed: true })).toBeVisible();
  });

  // The repro from the finding, stated directly.
  it('leaves an explicit "none" alone when None is clicked again', async () => {
    const { user } = render(
      <CrossFilterModeSection
        widgetId="widget-1"
        title="Interactions"
        modes={['cross-highlight', 'cross-filter', 'none']}
        defaultMode="cross-highlight"
        value="none"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'None' }));

    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'None', pressed: true })).toBeVisible();
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

    // M16 — BEHAVIOUR CHANGE. This used to assert that deselecting a NON-default selected
    // mode committed `defaultMode`, on the reasoning that "the resolved next value differs
    // from the stored one, so it's a real change". It is not a change the user asked for:
    // clicking the selected button expresses no new choice at all, and silently moving the
    // widget to a mode the user never clicked is the same bug as the `'none'` repro above,
    // just less visible. A deselect is now inert whatever the stored value is.
    it('does not commit when clicking a selected NON-default mode either', async () => {
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

      expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
    });
  });
});
