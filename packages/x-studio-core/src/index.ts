/**
 * `@mui/x-studio-core` — the framework-agnostic engine behind MUI X Studio.
 *
 * Everything a dashboard needs in order to *work*, with nothing about how it *looks*: the
 * document controller and its undo history, the four-layer row pipeline with its caches, filter
 * scoping, chart aggregation, expression evaluation, and the batching query adapter. No React, no
 * DOM — `vitest.config.node.mts` runs this package's suite in `node` precisely so that stays true.
 *
 * This is the package a non-React binding builds on. `@mui/x-studio` is the React one; an Angular
 * or Vue binding is a sibling of it rather than a wrapper around it, which is the whole reason
 * this boundary exists (see `x-studio/docs/SYSTEM_ARCHITECTURE_REVIEW.md`, finding A1).
 *
 * The barrel below is the curated surface. Deep imports (`@mui/x-studio-core/engine/…`) reach
 * everything else and are how the React binding consumes it today.
 */

// ── The document ─────────────────────────────────────────────────────────────
export { StudioController } from './store/StudioController';
export { MutationHistory, MAX_UNDO_HISTORY, MAX_MUTATION_LOG } from './store/MutationHistory';

// ── The row pipeline ─────────────────────────────────────────────────────────
// The non-React façade over L2–L4. A binding that wants rows without hooks starts here.
export { createStudioPipeline } from './engine/StudioPipeline';
export type { StudioPipeline, StudioPipelineState } from './engine/StudioPipeline';
export { getCachedNormalizedDataSource } from './engine/normalizedRowsCache';

// ── Data access ──────────────────────────────────────────────────────────────
export { createBatchingAdapter } from './adapter/createBatchingAdapter';
export { createSimpleAdapter } from './adapter/createSimpleAdapter';
export { StudioRequestCache, studioRequestCache } from './engine/StudioRequestCache';

// ── Localization ─────────────────────────────────────────────────────────────
export { DEFAULT_STUDIO_LOCALE_TEXT } from './engine/localeText';
export type { StudioLocaleText } from './engine/localeText';

// ── The shared data model ────────────────────────────────────────────────────
// Re-exported from `@mui/x-studio-schema` so a consumer needs one import for the engine and the
// types it operates on.
export * from './models';
