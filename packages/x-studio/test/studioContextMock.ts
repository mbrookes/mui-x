import { vi } from 'vitest';

/**
 * Shared, stable mock for the x-studio `context` module (`useStudioSelector`,
 * `useStudioController`).
 *
 * Why this exists: the repo runs vitest with `isolate: false`, so the module
 * registry is shared across all test files in a worker. When two test files each
 * `vi.mock('.../context')` with a factory that closes over their own module-level
 * `mockState`/`controller`, only the FIRST file's factory binds to the (singleton)
 * context module. Source modules (e.g. `useChartWidgetData.ts`) load once and bind
 * to that first mock. A second file mocking the same module then silently reads the
 * first file's state — producing order-dependent, flaky failures (the second file to
 * run in a worker fails).
 *
 * The fix: every `context`-mocking test file routes through the SAME stable `vi.fn()`s
 * exported here, which read from a per-file holder configured in `beforeEach`. Because
 * the fn references and the holder are shared, it no longer matters which file's
 * `vi.mock` factory wins — the currently-running file's state/controller is always
 * returned. The factory always overrides BOTH hooks so the mocked surface is identical
 * across files (otherwise a file that only mocks the selector would let the real
 * `useStudioController` leak to a file that needs it mocked).
 *
 * Usage in a test file:
 *
 *   import {
 *     mockUseStudioSelector,
 *     mockUseStudioController,
 *     configureStudioContextMock,
 *   } from '../../../../test/studioContextMock';
 *
 *   vi.mock('../../../context', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('../../../context')>()),
 *     useStudioSelector: mockUseStudioSelector,
 *     useStudioController: mockUseStudioController,
 *   }));
 *
 *   beforeEach(() => {
 *     mockState = createState();
 *     configureStudioContextMock({ getState: () => mockState, controller });
 *   });
 */

// Reads the live per-file `mockState` via a getter so mid-test reassignments
// (e.g. switching to a different data source within one test) still propagate.
let getState: () => unknown = () => {
  throw new Error(
    'studioContextMock: state getter not configured. Call configureStudioContextMock({ getState }) in beforeEach.',
  );
};
let getController: () => unknown = () => ({});

const selectorImpl = (selector: (state: any) => unknown) => selector(getState());
const controllerImpl = () => getController();

export const mockUseStudioSelector = vi.fn(selectorImpl);
export const mockUseStudioController = vi.fn(controllerImpl);

/**
 * Point the shared context mock at the currently-running test file's state and
 * controller. Call from each file's `beforeEach`.
 *
 * Re-applies the fn implementations on every call so it survives files whose
 * `afterEach` runs `vi.restoreAllMocks()` / `vi.resetAllMocks()` (which would
 * otherwise wipe the shared implementation for a later file).
 *
 * @param config.getState      Returns the state the selector mock resolves against.
 *   Pass a getter (not a value) so mid-test reassignments propagate.
 * @param config.controller    The object `useStudioController()` returns. Defaults to
 *   `{}` for files that don't use the controller.
 * @param config.getController Use instead of `controller` when the test file reassigns
 *   its controller mid-test (the getter is read live on each `useStudioController()` call).
 */
export function configureStudioContextMock(config: {
  getState: () => unknown;
  controller?: unknown;
  getController?: () => unknown;
}): void {
  getState = config.getState;
  getController = config.getController ?? (() => config.controller ?? {});
  mockUseStudioSelector.mockImplementation(selectorImpl);
  mockUseStudioController.mockImplementation(controllerImpl);
}
