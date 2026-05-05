import type { StudioState } from '../models';

/**
 * Module-level stable selector functions for use with useStudioSelector.
 *
 * Using module-level functions (rather than inline arrows) ensures selector
 * identity is stable across renders, which prevents unnecessary re-evaluations
 * in React 19's useSyncExternalStore path.
 */

export const selectFilters = (state: StudioState) => state.filters;
export const selectDataSources = (state: StudioState) => state.dataSources;
export const selectRelationships = (state: StudioState) => state.relationships;
export const selectExpressionFields = (state: StudioState) => state.expressionFields;
export const selectWidgets = (state: StudioState) => state.widgets;
export const selectMode = (state: StudioState) => state.mode;
export const selectShell = (state: StudioState) => state.shell;
export const selectActivePageId = (state: StudioState) => state.dashboard.activePageId;
export const selectPages = (state: StudioState) => state.dashboard.pages;
export const selectDashboard = (state: StudioState) => state.dashboard;
