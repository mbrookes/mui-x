/** Dashboard-level mutations: the title, the date range, and the cross-filter mode flags. */
import * as docTransforms from '../docTransforms';
import type { HandlersFor } from './shared';

export const DASHBOARD_MUTATION_HANDLERS: HandlersFor<
  | 'setDashboardTitle'
  | 'setDashboardDateRange'
  | 'setDashboardDateRangeAll'
  | 'setGlobalCrossFilterMode'
  | 'setCrossFilterAllPages'
> = {
  setDashboardTitle: {
    apply: (state, args) => {
      // Require a STRING title: `StudioDoc['dashboard'].title` is `string` and the
      // page-header renderer reads it directly, so a non-string value corrupts the title
      // until something downstream trips over it.
      if (typeof args.title !== 'string') {
        return state;
      }
      // Reference-equality no-op: re-writing the identical title returns the SAME doc
      // so `commitDocPatch`'s no-op guard skips a spurious undo entry.
      if (state.dashboard.title === args.title) {
        return state;
      }
      return {
        ...state,
        dashboard: { ...state.dashboard, title: args.title },
      };
    },
    label: () => 'setDashboardTitle',
  },

  setDashboardDateRange: {
    apply: (state, args) =>
      typeof args.pageId === 'string'
        ? docTransforms.setDashboardDateRange(
            state,
            args.pageId,
            args.fieldId,
            args.sourceId,
            args.fieldType,
            args.preset,
            args.customFrom,
            args.customTo,
          )
        : state,
    label: (args) => `setDashboardDateRange:${args.pageId}`,
  },

  setDashboardDateRangeAll: {
    apply: (state, args) =>
      typeof args.pageId === 'string' && Array.isArray(args.fields)
        ? docTransforms.setDashboardDateRangeAll(
            state,
            args.pageId,
            args.fields,
            args.preset,
            args.customFrom,
            args.customTo,
          )
        : state,
    label: (args) => `setDashboardDateRangeAll:${args.pageId}`,
  },

  /*
   * ── Dashboard cross-filter settings and page-record writes ─────────────────────────────
   *
   * The last five. Each is a plain field write with a value-equality bail; none carries a
   * cross-entity invariant. They are here for the same reason as the relationship handlers —
   * so that "the reducer is the one implementation of every mutation's effect" holds without a
   * qualifier.
   */
  setGlobalCrossFilterMode: {
    apply: (state, args) =>
      state.dashboard.globalCrossFilterMode === args.mode
        ? state
        : { ...state, dashboard: { ...state.dashboard, globalCrossFilterMode: args.mode } },
    label: (args) => `setGlobalCrossFilterMode:${args.mode}`,
  },

  setCrossFilterAllPages: {
    apply: (state, args) =>
      typeof args.allPages !== 'boolean' || state.dashboard.crossFilterAllPages === args.allPages
        ? state
        : { ...state, dashboard: { ...state.dashboard, crossFilterAllPages: args.allPages } },
    label: (args) => `setCrossFilterAllPages:${args.allPages}`,
  },
};
