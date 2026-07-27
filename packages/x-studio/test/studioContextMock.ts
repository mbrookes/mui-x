import * as React from 'react';
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
 *
 * ## Two modes: snapshot (default) and subscribed (opt-in)
 *
 * **Snapshot mode** — what you get from `{ getState }` alone, and what every existing
 * call site uses. `useStudioSelector` is `selector(getState())`: the state is read once
 * per render and nothing is subscribed to. A controller write during a test mutates the
 * holder but re-renders nothing, so any behaviour that depends on a component reacting
 * to a store change is invisible — a test asserting it passes with or without the
 * production code that implements it. Files in this mode drive the re-render by hand
 * (a `nonce` prop, `setProps`, `rerender`).
 *
 * **Subscribed mode** — opt in by passing `store` (a `StudioController`'s `.store`, or
 * anything with `subscribe`/`getSnapshot`) or a bare `subscribe`. `useStudioSelector`
 * then runs through `useSyncExternalStore` exactly as production does: a
 * `controller.<mutation>()` notifies subscribers, each subscribed component re-reads its
 * selector, and React re-renders **only** those whose selected value changed by
 * `Object.is`. That makes both halves testable — that a store write updates the UI, and
 * that an unrelated store write does *not* re-render (the reference-stability contract
 * `context/selectors.ts` exists to uphold).
 *
 *   beforeEach(() => {
 *     controller = new StudioController(initialState);
 *     configureStudioContextMock({ store: controller.store, controller });
 *   });
 *   // ...then, inside a test:
 *   act(() => { controller.addFilter(...); });   // components re-render on their own
 *
 * Subscribed mode inherits `useSyncExternalStore`'s contract: `selector(state)` MUST
 * return a referentially stable value while `state` is unchanged, or React throws
 * "The result of getSnapshot should be cached to avoid an infinite loop". That is the
 * same constraint production selectors are written against, which is the point — the
 * mock no longer lets a selector pass here that would loop in the real app.
 *
 * Snapshot mode has no such constraint: its `getSnapshot` is a module constant, so a
 * `getState` that mints a fresh object per call stays legal exactly as before.
 *
 * The mode is a module-level switch set by `configureStudioContextMock`, so it must not
 * change while a component is mounted (call it from `beforeEach`, before rendering — as
 * every file already does). The hook call sequence itself is identical in both modes, so
 * switching between test files is safe.
 */

type Subscribe = (onStoreChange: () => void) => () => void;

/** The subset of `Store<StudioState>` the mock needs to drive re-renders. */
export interface StudioContextMockStore {
  subscribe: Subscribe;
  getSnapshot: () => unknown;
}

// Reads the live per-file `mockState` via a getter so mid-test reassignments
// (e.g. switching to a different data source within one test) still propagate.
let getState: () => unknown = () => {
  throw new Error(
    'studioContextMock: state getter not configured. Call configureStudioContextMock({ getState }) in beforeEach.',
  );
};
let getController: () => unknown = () => ({});
/** Non-null only in subscribed mode. */
let subscribe: Subscribe | null = null;

// Snapshot-mode placeholders. `useSyncExternalStore` is called in BOTH modes so the hook
// sequence never depends on the mode; in snapshot mode it is wired to a subscription that
// never fires and a snapshot that never changes, so it is inert and the selected value is
// still computed fresh on every render (the pre-existing behaviour, byte for byte).
const NOOP_SUBSCRIBE: Subscribe = () => () => {};
const getInertSnapshot = () => null;

function useSelectorImpl(selector: (state: any) => unknown) {
  const subscribeFn = subscribe;
  const getSelection = React.useCallback(() => selector(getState()), [selector]);
  const subscribed = React.useSyncExternalStore(
    subscribeFn ?? NOOP_SUBSCRIBE,
    subscribeFn ? getSelection : getInertSnapshot,
    subscribeFn ? getSelection : getInertSnapshot,
  );
  return subscribeFn ? subscribed : selector(getState());
}

const controllerImpl = () => getController();

export const mockUseStudioSelector = vi.fn(useSelectorImpl);
export const mockUseStudioController = vi.fn(controllerImpl);

interface StudioContextMockConfigBase {
  /** The object `useStudioController()` returns. Defaults to `{}`. */
  controller?: unknown;
  /**
   * Use instead of `controller` when the test file reassigns its controller mid-test
   * (the getter is read live on each `useStudioController()` call).
   *
   * @returns {unknown} The object `useStudioController()` should return for the current test.
   */
  getController?: () => unknown;
  /**
   * Opt in to subscription-driven re-renders. Pass a real `StudioController`'s `.store`
   * (or anything exposing `subscribe`/`getSnapshot`). `getState` then defaults to
   * `store.getSnapshot`.
   */
  store?: StudioContextMockStore;
  /**
   * Lower-level alternative to `store`: subscribe only. Use when the state getter and the
   * change notifications come from different places. Requires `getState`.
   */
  subscribe?: Subscribe;
}

/**
 * Point the shared context mock at the currently-running test file's state and
 * controller. Call from each file's `beforeEach`.
 *
 * Re-applies the fn implementations on every call so it survives files whose
 * `afterEach` runs `vi.restoreAllMocks()` / `vi.resetAllMocks()` (which would
 * otherwise wipe the shared implementation for a later file). It also RESETS the
 * subscribed-mode switch, so a file that opts in cannot leak reactivity into the next
 * file to run in the same worker.
 *
 * @param config.getState Returns the state the selector mock resolves against. Pass a
 *   getter (not a value) so mid-test reassignments propagate. Optional only when `store`
 *   is given, in which case it defaults to `store.getSnapshot`.
 */
export function configureStudioContextMock(
  config: StudioContextMockConfigBase & { getState: () => unknown },
): void;
export function configureStudioContextMock(
  config: StudioContextMockConfigBase & { store: StudioContextMockStore; getState?: () => unknown },
): void;
export function configureStudioContextMock(
  config: StudioContextMockConfigBase & { getState?: () => unknown },
): void {
  const store = config.store;
  if (config.getState) {
    getState = config.getState;
  } else if (store) {
    getState = store.getSnapshot;
  } else {
    throw new Error(
      'studioContextMock: configureStudioContextMock needs `getState`, `store`, or both.',
    );
  }
  getController = config.getController ?? (() => config.controller ?? {});
  subscribe = config.subscribe ?? store?.subscribe ?? null;
  mockUseStudioSelector.mockImplementation(useSelectorImpl);
  mockUseStudioController.mockImplementation(controllerImpl);
}

/**
 * Reads the currently-configured per-file mock state. Used by hook mocks (e.g. a mocked
 * `useWidgetRows`) that need to derive store-dependent values — such as the resolved/scoped
 * filter sets exposed for L4 re-anchoring (finding 2.1) — from the SAME state the context
 * selectors resolve against, rather than re-declaring a parallel fixture.
 */
export function getConfiguredStudioState<T = unknown>(): T {
  return getState() as T;
}
