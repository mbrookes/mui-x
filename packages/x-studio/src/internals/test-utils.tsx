import * as React from 'react';
import { StudioController } from '@mui/x-studio-core/store';
import { StudioProvider } from '../context/StudioContext';
import type { StudioProviderProps } from '../context/StudioContext';
import type { CreateDefaultStudioStateOverrides } from '../models';

/**
 * Shared test harness for x-studio component tests.
 *
 * Renders components inside a *real* `StudioProvider` backed by a real
 * `StudioController`, rather than mocking the `../context` module. This avoids
 * the `isolate: false` cross-file `vi.mock` fragility (a mocked context module
 * collides with sibling test files that import the real one) and exercises the
 * genuine store/selector wiring, so assertions can check real state mutations
 * via spies on the controller.
 *
 * Usage:
 * ```tsx
 * const { render } = createRenderer();
 *
 * it('selects the widget on click', async () => {
 *   const { controller, wrapper } = createStudioHarness({
 *     initialState: { doc: { widgets: { w1: makeWidget() } } },
 *   });
 *   const selectSpy = vi.spyOn(controller, 'selectWidget');
 *   const { user } = render(<StudioWidgetCard widgetId="w1" />, { wrapper });
 *   await user.click(screen.getByText('My widget'));
 *   expect(selectSpy).toHaveBeenCalledWith('w1');
 * });
 * ```
 */
export interface StudioHarnessOptions {
  /**
   * Overrides merged into `createDefaultStudioState` defaults, one bag per
   * lifetime partition (`doc`/`session`/`runtime`) — see
   * `CreateDefaultStudioStateOverrides` for why this isn't a flat shape.
   */
  initialState?: CreateDefaultStudioStateOverrides;
  /** Extra `StudioProvider` props (featureFlags, localeText, customWidgets, …). */
  providerProps?: Partial<Omit<StudioProviderProps, 'controller' | 'children'>>;
}

export interface StudioHarness {
  /** The real controller backing the provider — spy on its methods to assert. */
  controller: StudioController;
  /** Wrapper to pass as `render(ui, { wrapper })`. */
  wrapper: (props: { children?: React.ReactNode }) => React.ReactElement;
}

export function createStudioHarness(options: StudioHarnessOptions = {}): StudioHarness {
  const controller = new StudioController(options.initialState);

  function wrapper(props: { children?: React.ReactNode }) {
    return (
      <StudioProvider controller={controller} {...options.providerProps}>
        {props.children}
      </StudioProvider>
    );
  }

  return { controller, wrapper };
}
