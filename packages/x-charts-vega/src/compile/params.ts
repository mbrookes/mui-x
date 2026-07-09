import type {
  VegaLayerSpec,
  VegaLiteSpec,
  VegaParam,
  VegaSelectionDef,
  VegaUnitSpec,
} from '../types';
import type { GapCollector } from '../gaps';

/*
 * OWNERSHIP: the "selections subset" work unit owns this file.
 *
 * Translate the mappable subset of Vega-Lite `params` (selections):
 * - `select: 'point'` (or {type: 'point'}) → return a highlightScope so the
 *   orchestrator applies item hover-highlighting to every series
 *   ({highlight: 'item', fade: 'global'} — x-charts' controlled highlight);
 *   `on`/`toggle`/`fields`/`encodings`/`nearest` refinements → 'ignored' gaps.
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

interface ParamGroup {
  params: VegaParam[];
  /** Locator prefix for this group's params, e.g. `$.params` or `layer[0].params`. */
  path: string;
}

/**
 * Collects `params` arrays from the top level and (per the task's "keep it
 * simple" scope) the spec's first-level `layer` entries.
 * @param {VegaLiteSpec} spec The full input spec.
 * @returns {ParamGroup[]} Every params array found, tagged with a gap-path prefix.
 */
function collectParamGroups(spec: VegaLiteSpec): ParamGroup[] {
  const groups: ParamGroup[] = [];

  const topParams = (spec as VegaUnitSpec).params;
  if (Array.isArray(topParams)) {
    groups.push({ params: topParams as VegaParam[], path: '$.params' });
  }

  const layer = (spec as VegaLayerSpec).layer;
  if (Array.isArray(layer)) {
    layer.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const layerParams = (entry as VegaUnitSpec).params;
      if (Array.isArray(layerParams)) {
        groups.push({ params: layerParams as VegaParam[], path: `layer[${index}].params` });
      }
    });
  }

  return groups;
}

/** Extracts the selection `type` from either the shorthand string or object form. */
function selectionType(select: VegaParam['select']): string | undefined {
  if (typeof select === 'string') {
    return select;
  }
  if (select && typeof select === 'object') {
    return select.type;
  }
  return undefined;
}

const POINT_REFINEMENTS: ReadonlyArray<{
  key: keyof VegaSelectionDef;
  code: string;
  message: string;
}> = [
  {
    key: 'on',
    code: 'param:point-on',
    message:
      "Point selection 'on' event trigger is not applied; x-charts' controlled item highlight always triggers on pointer hover.",
  },
  {
    key: 'toggle',
    code: 'param:point-toggle',
    message:
      "Point selection 'toggle' (multi-select via click/ctrl-click) is not applied; x-charts' item highlight only tracks a single hovered item at a time.",
  },
  {
    key: 'fields',
    code: 'param:point-fields',
    message:
      "Point selection 'fields' (grouping the selection by data field instead of event target) is not applied; the highlight always scopes to the hovered item.",
  },
  {
    key: 'encodings',
    code: 'param:point-encodings',
    message:
      "Point selection 'encodings' (restricting which channels drive the selection) is not applied; the highlight always follows whichever item is hovered.",
  },
  {
    key: 'nearest',
    code: 'param:point-nearest',
    message:
      "Point selection 'nearest' (snapping to the closest datum instead of the exact pointer target) is not applied; x-charts' own hover-target resolution is used instead.",
  },
];

/**
 * Translates the mappable subset of Vega-Lite `params` (selections and
 * variables) into an x-charts-facing resolution, reporting a gap for every
 * feature that could not be (fully) translated.
 * @param {VegaLiteSpec} spec The full input spec.
 * @param {GapCollector} gaps Collector for translation gaps encountered along the way.
 * @returns {ParamsResolution} The mappable subset of `params`, currently only a highlightScope.
 */
export function resolveParams(spec: VegaLiteSpec, gaps: GapCollector): ParamsResolution {
  let highlightScope: ParamsResolution['highlightScope'];

  for (const group of collectParamGroups(spec)) {
    for (let index = 0; index < group.params.length; index += 1) {
      const param = group.params[index];
      if (!param || typeof param !== 'object') {
        continue;
      }
      const path = `${group.path}[${index}]`;
      const hasSelect = param.select !== undefined;

      if (hasSelect) {
        const type = selectionType(param.select);
        if (type === 'point') {
          highlightScope = { highlight: 'item', fade: 'global' };
          if (typeof param.select === 'object') {
            const select = param.select;
            for (const { key, code, message } of POINT_REFINEMENTS) {
              if (select[key] !== undefined) {
                gaps.add({
                  code,
                  message,
                  severity: 'ignored',
                  path: `${path}.select.${key}`,
                });
              }
            }
          }
        } else if (type === 'interval') {
          gaps.add({
            code: 'param:interval',
            message:
              "Vega-Lite interval selection (select: 'interval') has no x-charts equivalent: @mui/x-charts-pro has brush/zoom interactions (e.g. ChartZoomSlider), but they pan/zoom the view rather than reproducing Vega's interval-selection semantics (conditional encodings, cross-filtering driven by the dragged range). Workaround: implement selection-driven filtering in application state and re-render with filtered data.",
            severity: 'partial',
            path,
          });
        }
      } else if (param.value !== undefined) {
        gaps.add({
          code: 'param:variable',
          message:
            'Value-only Vega-Lite params (variables) are not evaluated: this wrapper does not run a Vega expression interpreter against param values, so encodings/transforms/conditions referencing this param see no live value from it. Workaround: compute the derived value yourself and pass it in via the data/encoding you provide.',
          severity: 'ignored',
          path,
        });
      }

      if (param.bind !== undefined) {
        gaps.add({
          code: 'param:bind',
          message:
            'Vega-Lite `bind` (input widgets, or legend/scale binding) has no x-charts equivalent: the wrapper does not render input widgets or wire them to selections. Workaround: implement the equivalent control with React state and pass the resulting value through the data/encoding you provide.',
          severity: 'unsupported',
          path: `${path}.bind`,
        });
      }
    }
  }

  return highlightScope ? { highlightScope } : {};
}
