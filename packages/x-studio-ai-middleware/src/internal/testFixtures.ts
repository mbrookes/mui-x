/**
 * Shared fixtures for the tests that exercise this package's trust boundaries.
 *
 * Test-only — nothing in `src` imports it. It exists because `capIncomingDashboardState`'s tests
 * moved to `requestCaps.test.ts` with the function itself, and both they and
 * `executeToolOnState.test.ts` need the same two helpers. Duplicating them would recreate, in
 * the tests, exactly the hand-kept-copy problem this round of work has been removing from the
 * source.
 */
import { createDefaultStudioState } from '../models/studioTypes';
import type { StudioState } from '../models/studioTypes';

/**
 * Installs entries that `createDefaultStudioState` would screen out.
 *
 * The factory now runs the shared `screenDoc` per-entry screens — the same ones
 * `deserializeState` applies — so a hostile fixture written THROUGH it is sanitized
 * before the function under test sees it. That screening is correct, and it is
 * deliberately NOT on the path these tests cover: `body.dashboardState` arrives over the
 * wire and reaches `capIncomingDashboardState`/`executeToolOnState` without passing
 * through the factory at all. Build the clean shell with the factory, then install the
 * hostile entries directly — that is what the wire can actually deliver.
 */
export function installUnscreened<T extends object>(target: T, key: string, value: unknown): T {
  // `defineProperty`, and an explicit `key` parameter rather than a patch object: writing
  // `{ __proto__: value }` as a literal sets the PROTOTYPE instead of an own key, so the
  // entry would silently never be installed — the very confusion these tests exist to pin.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return target;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function makeState(): StudioState {
  const pageId = 'page-1';
  const widgetId = 'widget-1';
  return createDefaultStudioState({
    doc: {
      dashboard: { id: 'd1', title: 'Dashboard', activePageId: pageId },
      pages: {
        [pageId]: {
          id: pageId,
          title: 'Page 1',
          widgetRows: [[widgetId]],
        },
      },
      widgets: {
        [widgetId]: {
          id: widgetId,
          kind: 'chart',
          title: 'Revenue Chart',
          sourceId: 'src1',
          config: { chartType: 'bar' },
        },
      },
      filters: [
        {
          id: 'filter-1',
          field: 'revenue',
          operator: 'greater_than',
          value: 100,
          scope: { kind: 'page', pageId },
        },
      ],
    },
    runtime: {
      dataSources: {
        src1: {
          id: 'src1',
          label: 'Sales',
          fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
        },
      },
    },
  });
}
