/**
 * Shared `Object.hasOwn`-guarded entity lookups for `state.doc.widgets` /
 * `state.doc.pages`.
 *
 * Every entity map in `state.doc` (`widgets`, `pages`, …) is a plain object, so a
 * bare `map[id]` walks the prototype chain: a model-supplied id like `"constructor"`,
 * `"toString"`, or `"__proto__"` resolves to a truthy inherited value instead of
 * `undefined` — even though the shared reducer (`applyMutation.ts`) is fully
 * `Object.hasOwn`-hardened and silently no-ops on that same key. This mismatch was
 * finding T2-1, independently rediscovered and hand-rolled in `executeToolOnState.ts`
 * (`getWidget`/`getPage`), `buildAISystemPrompt.ts` (`getPage`/`getWidget`, taking the
 * map directly rather than `state`), and twice more inline inside
 * `agenticLoop/toolDispatch.ts` (`buildApprovalDisplayInput`'s `readWidget`/`readPage`,
 * and `buildApprovalEffectsSummary`'s `widgetTitle`/`pageTitle`). Centralised here so
 * every lookup site agrees with the reducer's own-property discipline by construction
 * instead of by each call site remembering to guard it.
 *
 * Internal to the package — not exported from `index.ts`.
 */
import type { StudioState, StudioWidget } from '../models/studioTypes';

/** `Object.hasOwn`-guarded widget lookup against a widget map directly. */
export function getWidgetFromMap(
  widgets: StudioState['doc']['widgets'],
  id: string,
): StudioWidget | undefined {
  return Object.hasOwn(widgets, id) ? widgets[id] : undefined;
}

/** `Object.hasOwn`-guarded page lookup against a page map directly. */
export function getPageFromMap(
  pages: StudioState['doc']['pages'],
  id: string,
): StudioState['doc']['pages'][string] | undefined {
  return Object.hasOwn(pages, id) ? pages[id] : undefined;
}

/** `Object.hasOwn`-guarded widget lookup (see module doc). */
export function getWidget(state: StudioState, id: string): StudioWidget | undefined {
  return getWidgetFromMap(state.doc.widgets, id);
}

/** `Object.hasOwn`-guarded page lookup (see module doc). */
export function getPage(
  state: StudioState,
  id: string,
): StudioState['doc']['pages'][string] | undefined {
  return getPageFromMap(state.doc.pages, id);
}
