import type {
  DatasetRow,
  VegaBindInput,
  VegaLayerSpec,
  VegaLiteSpec,
  VegaParam,
  VegaSelectionDef,
  VegaUnitSpec,
} from '../types';
import type { GapCollector } from '../gaps';
import { createGapCollector } from '../gaps';
import { compileExpression, isTruthy, UnsupportedExpressionError } from '../transforms/calculate';

/*
 * OWNERSHIP: the "selections & interactivity" work unit owns this file.
 *
 * Translate the mappable subset of Vega-Lite `params` (selections and
 * variables) into an x-charts-facing resolution:
 * - `select: 'point'` → a highlightScope (controlled item hover-highlight);
 *   refinements (`on`/`toggle`/`fields`/`encodings`/`nearest`) → 'ignored' gaps.
 * - `select: 'interval'` with `bind: 'scales'` → per-axis zoom/pan enablement
 *   (Vega's scale-bound interval idiom); a plain `select: 'interval'` (no
 *   scale binding) stays a 'partial' gap.
 * - Named variable params (`{name, value}`) → an initial signal value the
 *   expression evaluator can read (calculate/filter/test conditions).
 * - `bind: {input}` input widgets (range/select/checkbox/radio) with a name →
 *   an input-widget descriptor the shell renders as a control.
 * - `condition` blocks with `test` predicates and constant values →
 *   per-row resolvers (compileTestConditions), consumed by the text/image
 *   mark compilers.
 */

export interface CompiledParamInput {
  /** The param name; the input's value is written to this signal. */
  name: string;
  kind: 'range' | 'select' | 'checkbox' | 'radio';
  /** Human-readable label (the bind's `name`, falling back to the param name). */
  label: string;
  initialValue: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** Choices for select/radio inputs (raw, type-preserving). */
  options?: unknown[];
  /** Display labels index-aligned with `options`. */
  labels?: string[];
}

/**
 * A point selection's state at first render, which is all a static wrapper can
 * reproduce. Vega-Lite renders a spec's INITIAL frame before any interaction,
 * and that frame is fully determined by the spec: a selection either starts
 * empty, or starts pre-seeded by the param's own `value`.
 */
export interface SelectionInitialState {
  /**
   * The param's initial `value` for a point selection, normalised to a list of
   * field→value tuples (`value: [{year: 1955}]`). A row is "selected" when it
   * matches every field of any tuple. Absent when the selection starts empty.
   */
  initial?: Array<Record<string, unknown>>;
  /** Whether this is a point selection — interval state isn't reproduced. */
  point: boolean;
}

/** Initial selection states keyed by param name (see `SelectionInitialState`). */
export type SelectionStates = Readonly<Record<string, SelectionInitialState>>;

export interface ParamsResolution {
  /** When set, the orchestrator applies this highlightScope to every series. */
  highlightScope?: { highlight: 'item'; fade: 'global' };
  /** Per-axis zoom/pan enablement requested by scale-bound interval selections. */
  zoom?: { x: boolean; y: boolean };
  /** Input-widget descriptors for bound variable params. */
  inputs?: CompiledParamInput[];
  /** Initial signal values (variable params + input defaults), keyed by name. */
  initialValues?: Record<string, unknown>;
  /** Initial state of each selection param, for `{param}` filter predicates. */
  selections?: SelectionStates;
}

/**
 * Normalise a point selection's `value` into field→value tuples. Vega-Lite
 * accepts the single-object shorthand (`value: {year: 1955}`) alongside the
 * canonical array, and a scalar/other shape carries no field mapping we can
 * turn into a predicate, so it yields nothing (an empty selection).
 */
function normaliseSelectionValue(value: unknown): Array<Record<string, unknown>> | undefined {
  const isTuple = (entry: unknown): entry is Record<string, unknown> =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry);
  const list = Array.isArray(value) ? value : [value];
  const tuples = list.filter(isTuple);
  return tuples.length > 0 ? tuples : undefined;
}

/**
 * Collect every selection param's initial state, walking the WHOLE spec rather
 * than reusing `collectParamGroups` (which is deliberately scoped to the top
 * level and first-level layers, and drives gap paths and input widgets). A
 * param name is spec-global in Vega-Lite, and a `{param}` filter can reference
 * one declared far from it — `interactive_global_development` declares `year`
 * at `layer[1].layer[1]` and filters on it from three different layers, so a
 * shallow scan resolves none of them.
 *
 * `data`/`datasets` are skipped: a data row can legitimately contain a `params`
 * key and must never be mistaken for a param declaration.
 */
function collectSelectionStates(spec: VegaLiteSpec): Record<string, SelectionInitialState> {
  const states: Record<string, SelectionInitialState> = {};
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') {
      return;
    }
    const record = node as Record<string, unknown>;
    const params = record.params;
    if (Array.isArray(params)) {
      for (const entry of params as VegaParam[]) {
        if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
          continue;
        }
        if (entry.select === undefined) {
          continue;
        }
        const point = selectionType(entry.select) === 'point';
        states[entry.name] = {
          point,
          ...(point ? { initial: normaliseSelectionValue(entry.value) } : {}),
        };
      }
    }
    for (const key of Object.keys(record)) {
      if (key === 'data' || key === 'datasets') {
        continue;
      }
      walk(record[key]);
    }
  };
  walk(spec);
  return states;
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

/** Input widget kinds the shell can render as a control. */
const SUPPORTED_INPUTS = ['range', 'select', 'checkbox', 'radio'] as const;

/** Returns the bind as an input-widget definition when it declares an `input` string. */
function getBindInputDef(bind: VegaParam['bind']): VegaBindInput | undefined {
  if (
    bind &&
    typeof bind === 'object' &&
    !Array.isArray(bind) &&
    typeof (bind as VegaBindInput).input === 'string'
  ) {
    return bind as VegaBindInput;
  }
  return undefined;
}

/** Whether a condition's `value` is a translatable constant (not a field/param reference). */
function isPrimitiveValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** Per-axis zoom enablement from an interval selection's `encodings` restriction. */
function zoomFromSelect(select: VegaParam['select']): { x: boolean; y: boolean } {
  if (select && typeof select === 'object' && Array.isArray(select.encodings)) {
    const encodings = select.encodings as unknown[];
    return { x: encodings.includes('x'), y: encodings.includes('y') };
  }
  return { x: true, y: true };
}

/**
 * Builds an input-widget descriptor from a supported, named `bind` input, or
 * reports the reason it couldn't and returns undefined. Assumes the caller has
 * already checked that `bindDef.input` is one of `SUPPORTED_INPUTS` and that
 * `param.name` is present.
 * @param {VegaParam} param The variable param carrying the binding.
 * @param {VegaBindInput} bindDef The input binding definition.
 * @param {string} path Locator prefix for reported gaps.
 * @param {GapCollector} gaps Collector for translation gaps.
 * @returns {CompiledParamInput | undefined} The descriptor, or undefined when it couldn't be built.
 */
function buildParamInput(
  param: VegaParam,
  bindDef: VegaBindInput,
  path: string,
  gaps: GapCollector,
): CompiledParamInput | undefined {
  const name = param.name as string;
  const label = typeof bindDef.name === 'string' ? bindDef.name : name;

  // `debounce` throttles input propagation; the React control fires eagerly.
  if (bindDef.debounce !== undefined) {
    gaps.add({
      code: 'param:bind-debounce',
      message:
        'The `debounce` on an input binding is ignored; the rendered control updates the param on every change.',
      severity: 'ignored',
      path: `${path}.bind`,
    });
  }

  if (bindDef.input === 'range') {
    const min = typeof bindDef.min === 'number' ? bindDef.min : 0;
    const max = typeof bindDef.max === 'number' ? bindDef.max : 100;
    const step = typeof bindDef.step === 'number' ? bindDef.step : undefined;
    return {
      name,
      kind: 'range',
      label,
      initialValue: param.value ?? min,
      min,
      max,
      ...(step !== undefined ? { step } : {}),
    };
  }

  if (bindDef.input === 'checkbox') {
    return {
      name,
      kind: 'checkbox',
      label,
      initialValue: param.value ?? false,
    };
  }

  // select / radio
  const options = Array.isArray(bindDef.options) ? bindDef.options : undefined;
  if (!options || options.length === 0) {
    gaps.add({
      code: 'param:bind-options',
      message: `A \`${bindDef.input}\` input binding needs an \`options\` array to enumerate its choices; without one no control could be rendered and the binding was dropped.`,
      severity: 'unsupported',
      path: `${path}.bind`,
    });
    return undefined;
  }
  const labels = Array.isArray(bindDef.labels) ? bindDef.labels.map(String) : undefined;
  return {
    name,
    kind: bindDef.input as 'select' | 'radio',
    label,
    initialValue: param.value ?? options[0],
    options: options.slice(),
    ...(labels ? { labels } : {}),
  };
}

/**
 * Translates the mappable subset of Vega-Lite `params` (selections and
 * variables) into an x-charts-facing resolution, reporting a gap for every
 * feature that could not be (fully) translated.
 * @param {VegaLiteSpec} spec The full input spec.
 * @param {GapCollector} gaps Collector for translation gaps encountered along the way.
 * @returns {ParamsResolution} The mappable subset of `params`.
 */
export function resolveParams(spec: VegaLiteSpec, gaps: GapCollector): ParamsResolution {
  let highlightScope: ParamsResolution['highlightScope'];
  let zoom: ParamsResolution['zoom'];
  const inputs: CompiledParamInput[] = [];
  const initialValues: Record<string, unknown> = {};
  const selections = collectSelectionStates(spec);

  for (const group of collectParamGroups(spec)) {
    for (let index = 0; index < group.params.length; index += 1) {
      const param = group.params[index];
      if (!param || typeof param !== 'object') {
        continue;
      }
      const path = `${group.path}[${index}]`;
      const hasSelect = param.select !== undefined;
      const bind = param.bind;
      const bindDef = getBindInputDef(bind);
      let bindHandled = false;

      if (hasSelect) {
        const type = selectionType(param.select);
        if (type === 'point') {
          highlightScope = { highlight: 'item', fade: 'global' };
          if (typeof param.select === 'object') {
            const select = param.select;
            for (const { key, code, message } of POINT_REFINEMENTS) {
              if (select[key] !== undefined) {
                gaps.add({ code, message, severity: 'ignored', path: `${path}.select.${key}` });
              }
            }
          }
        } else if (type === 'interval') {
          if (bind === 'scales') {
            const axes = zoomFromSelect(param.select);
            zoom = zoom ? { x: zoom.x || axes.x, y: zoom.y || axes.y } : axes;
            bindHandled = true;
            // A scale-bound interval's `value` seeds an initial zoom domain,
            // which x-charts' gesture zoom doesn't accept declaratively.
            if (param.value !== undefined) {
              gaps.add({
                code: 'param:interval-init',
                message:
                  "A scale-bound interval selection's initial `value` (starting zoom domain) is ignored; the chart opens at the full data extent.",
                severity: 'ignored',
                path,
              });
            }
          } else {
            gaps.add({
              code: 'param:interval',
              message:
                "Vega-Lite interval selection (select: 'interval') has no x-charts equivalent unless it is bound to scales (`bind: 'scales'`, which maps to gesture zoom/pan): a plain interval selection would drive conditional encodings / cross-filtering, which this wrapper does not reproduce. Workaround: add `bind: 'scales'` for zoom/pan, or implement selection-driven filtering in application state and re-render with filtered data.",
              severity: 'partial',
              path,
            });
          }
        }
      } else if (bindDef && SUPPORTED_INPUTS.includes(bindDef.input as never) && param.name) {
        const input = buildParamInput(param, bindDef, path, gaps);
        if (input) {
          inputs.push(input);
          initialValues[input.name] = input.initialValue;
        }
        bindHandled = true;
      } else if (param.value !== undefined) {
        if (param.name) {
          if (!(param.name in initialValues)) {
            initialValues[param.name] = param.value;
          }
        } else {
          gaps.add({
            code: 'param:variable',
            message:
              'A value-only Vega-Lite param (variable) has no name, so expressions/transforms cannot reference it and its value is ignored. Workaround: give the param a `name` to make it readable from `calculate`/`filter`/`test` expressions.',
            severity: 'ignored',
            path,
          });
        }
      }

      if (bind !== undefined && !bindHandled) {
        gaps.add({
          code: 'param:bind',
          message:
            'This Vega-Lite `bind` has no x-charts equivalent: only input widgets (`range`/`select`/`checkbox`/`radio`) on named variable params render as controls, and only `bind: "scales"` on an interval selection maps to zoom/pan. Legend binding, scale binding on non-interval params, and other input types are not wired up.',
          severity: 'unsupported',
          path: `${path}.bind`,
        });
      }
    }
  }

  const resolution: ParamsResolution = {};
  if (highlightScope) {
    resolution.highlightScope = highlightScope;
  }
  if (zoom) {
    resolution.zoom = zoom;
  }
  if (inputs.length > 0) {
    resolution.inputs = inputs;
  }
  if (Object.keys(initialValues).length > 0) {
    resolution.initialValues = initialValues;
  }
  if (Object.keys(selections).length > 0) {
    resolution.selections = selections;
  }
  return resolution;
}

/**
 * Spec-only extraction of the input-widget descriptors (range/select/checkbox/
 * radio) the shell renders as controls, without running a full compile. Uses a
 * throwaway gap collector — gap reporting for these bindings is the compiler's
 * job (via `resolveParams`).
 * @param {VegaLiteSpec} spec The full input spec.
 * @returns {CompiledParamInput[]} The bound input descriptors, in spec order.
 */
export function collectBindInputs(spec: VegaLiteSpec): CompiledParamInput[] {
  const gaps = createGapCollector();
  const inputs: CompiledParamInput[] = [];
  for (const group of collectParamGroups(spec)) {
    for (let index = 0; index < group.params.length; index += 1) {
      const param = group.params[index];
      if (!param || typeof param !== 'object' || param.select !== undefined || !param.name) {
        continue;
      }
      const bindDef = getBindInputDef(param.bind);
      if (!bindDef || !SUPPORTED_INPUTS.includes(bindDef.input as never)) {
        continue;
      }
      const input = buildParamInput(param, bindDef, `${group.path}[${index}]`, gaps);
      if (input) {
        inputs.push(input);
      }
    }
  }
  return inputs;
}

/**
 * Compiles a channel's `condition` into a per-row resolver for the test-
 * predicate subset (`{test: 'datum.x > 50', value: 'BIG'}`, or an array of
 * such entries evaluated first-match-wins). Returns undefined — reporting the
 * reason as a gap — when a condition references a param/selection, encodes a
 * field/non-constant value, or uses an unparseable test expression. The
 * returned resolver yields the matched entry's `value`, or undefined when no
 * test matches (the caller falls back to the base encoding).
 * @param {unknown} condition The channel's `condition` (object or array).
 * @param {Readonly<Record<string, unknown>> | undefined} signals Bound param values for the test expressions.
 * @param {GapCollector} gaps Collector for translation gaps.
 * @param {string} path Locator for reported gaps.
 * @returns {((row: DatasetRow) => unknown) | undefined} A per-row value resolver, or undefined when untranslatable.
 */
export function compileTestConditions(
  condition: unknown,
  signals: Readonly<Record<string, unknown>> | undefined,
  gaps: GapCollector,
  path: string,
): ((row: DatasetRow) => unknown) | undefined {
  const entries = Array.isArray(condition) ? condition : [condition];
  const compiled: Array<{ test: (row: DatasetRow) => unknown; value: unknown }> = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.test !== 'string' || !isPrimitiveValue(record.value)) {
      gaps.add({
        code: 'encoding:condition-param',
        message:
          'A `condition` that references a selection/param, or encodes a field (rather than a constant `value`) with a `test` predicate, is not translated; the base encoding is used for every row.',
        severity: 'unsupported',
        path,
      });
      return undefined;
    }
    let evaluator: (row: DatasetRow) => unknown;
    try {
      evaluator = compileExpression(record.test, signals);
    } catch (error) {
      if (!(error instanceof UnsupportedExpressionError)) {
        throw error;
      }
      gaps.add({
        code: 'encoding:condition-test',
        message: `A \`condition\` test expression ("${record.test}") uses syntax outside the supported subset; the condition was dropped and the base encoding is used for every row.`,
        severity: 'unsupported',
        path,
      });
      return undefined;
    }
    compiled.push({ test: evaluator, value: record.value });
  }

  if (compiled.length === 0) {
    return undefined;
  }

  let runtimeGapReported = false;
  return (row: DatasetRow) => {
    for (const entry of compiled) {
      let result: unknown;
      try {
        result = entry.test(row);
      } catch (error) {
        if (!(error instanceof UnsupportedExpressionError)) {
          throw error;
        }
        if (!runtimeGapReported) {
          runtimeGapReported = true;
          gaps.add({
            code: 'encoding:condition-test',
            message:
              'A `condition` test expression uses unsupported syntax for some rows; those rows fall back to the base encoding.',
            severity: 'unsupported',
            path,
          });
        }
        return undefined;
      }
      if (isTruthy(result)) {
        return entry.value;
      }
    }
    return undefined;
  };
}
