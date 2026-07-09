import type { VegaLiteSpec } from '../types';
import type { GapCollector } from '../gaps';

/*
 * OWNERSHIP: the "selections subset" work unit owns this file.
 *
 * Translate the mappable subset of Vega-Lite `params` (selections):
 * - `select: 'point'` (or {type: 'point'}) → return a highlightScope so the
 *   orchestrator applies item hover-highlighting to every series
 *   ({highlight: 'item', fade: 'global'} — x-charts' controlled highlight);
 *   `on`/`toggle`/`fields` refinements → 'ignored' gaps.
 * - `select: 'interval'` → 'partial' gap: x-charts Pro has brush/zoom but
 *   not Vega's interval-selection semantics (conditional encodings /
 *   cross-filtering).
 * - Value-only params (variables) and `bind` (input widgets) → 'unsupported'
 *   gaps with precise codes.
 * - `condition` blocks referencing params are reported where the color
 *   resolver already gaps them; this module only handles the params array.
 */

export interface ParamsResolution {
  /** When set, the orchestrator applies this highlightScope to every series. */
  highlightScope?: { highlight: 'item'; fade: 'global' };
}

export function resolveParams(spec: VegaLiteSpec, gaps: GapCollector): ParamsResolution {
  // Stub — implemented by the selections work unit. `spec.params` (and
  // per-unit params) are currently ignored without a gap.
  void spec;
  void gaps;
  return {};
}
