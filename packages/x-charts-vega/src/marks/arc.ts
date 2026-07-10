import type { PieItemId, PieSeriesType, PieValueType } from '@mui/x-charts/models';
import type { CompiledUnit, UnitContext } from '../compile/context';
import { resolveColor } from '../compile/color';
import { resolveFieldType, toNumber } from '../compile/fieldTypes';
import { isDatumDef, isFieldDef, isValueDef } from '../types';
import type { VegaFieldDef } from '../types';

/*
 * OWNERSHIP: the "arc/pie mark" work unit owns this file.
 *
 * Implement translation of the `arc` mark to an x-charts `type: 'pie'`
 * series:
 * - `theta` (quantitative, often aggregated) → slice `value`; `color` field
 *   → slice `label` (one datum per distinct color value);
 * - `mark.innerRadius`/`outerRadius`/`padAngle`/`cornerRadius` → the pie
 *   series' `innerRadius`/`outerRadius`/`paddingAngle`/`cornerRadius`;
 * - `theta2`/`radius` encodings and non-pie radial layouts → gaps;
 * - text layers on top of arcs (labels) → wired to the pie series' `arcLabel`
 *   (see readArcTextEncoding below), rendered by src/overlays/ArcLabels.tsx.
 *
 * Note the shell renders pie series with <PiePlot /> and no cartesian axes —
 * return `plots: ['pie']` (plus `'pieLabels'` when `arcLabel` is set) and no
 * axis-aligned data.
 */

/**
 * Reads the `text` encoding down to either a field name (per-slice lookup)
 * or a constant string, plus whether it carries a `format` d3-format string
 * (not translated — the raw value is stringified as-is instead).
 * `compileArcMark` turns this into an actual pie series `arcLabel` once the
 * color/theta fields (needed to pick the 'label'/'value' shortcuts) are
 * known.
 */
function readArcTextEncoding(
  encoding: UnitContext['encoding'],
):
  | { field: string; hasFormat: boolean }
  | { constant: string }
  | { unresolvable: true }
  | undefined {
  const textDef = encoding.text;
  if (textDef === undefined) {
    return undefined;
  }
  if (Array.isArray(textDef)) {
    // Vega-Lite multi-line text (an array of strings) has no equivalent —
    // `arcLabel` renders a single string per slice.
    return { unresolvable: true };
  }
  if (isFieldDef(textDef)) {
    const fieldDef = textDef as VegaFieldDef;
    if (!fieldDef.field) {
      // e.g. `{aggregate: 'count'}` with no `field` — nothing to read per row.
      return { unresolvable: true };
    }
    return { field: fieldDef.field, hasFormat: fieldDef.format !== undefined };
  }
  if (isValueDef(textDef) && textDef.value != null) {
    return { constant: String(textDef.value) };
  }
  if (isDatumDef(textDef)) {
    return { constant: String(textDef.datum) };
  }
  return { unresolvable: true };
}

/**
 * Reads the `order` encoding down to a per-slice sort field and direction.
 * Pie renders slices in `data` array order, so applying `order` is a matter of
 * sorting the built slice data by this field. Returns `undefined` when there is
 * nothing to sort (no `order` channel, a constant value order, or an explicit
 * `sort: null`) or when the spec can't be interpreted (in which case a
 * `partial` gap is recorded).
 */
function resolveArcOrder(
  encoding: UnitContext['encoding'],
  gaps: UnitContext['gaps'],
  path: string,
): { field: string; direction: 1 | -1 } | undefined {
  const orderDef = encoding.order;
  if (orderDef === undefined) {
    return undefined;
  }

  const addPartialGap = () => {
    gaps.add({
      code: 'encoding:arc-order',
      message:
        'This `order` channel could not be interpreted as a per-slice sort (only a `field` with an optional `sort: "ascending" | "descending"` is supported); slices follow the row order of the (post-aggregation) data instead.',
      severity: 'partial',
      path: `${path}.encoding.order`,
    });
  };

  if (Array.isArray(orderDef)) {
    // Multiple order fields have no single-key equivalent for a pie's slice
    // order; fall back to row order.
    addPartialGap();
    return undefined;
  }

  if (isValueDef(orderDef)) {
    // A constant value order (`order: {value: n}`) assigns every slice the same
    // rank — nothing to reorder.
    return undefined;
  }

  if (isFieldDef(orderDef) && orderDef.field) {
    const { sort } = orderDef;
    if (sort === null) {
      // Explicit "do not sort".
      return undefined;
    }
    if (sort === undefined || sort === 'ascending') {
      return { field: orderDef.field, direction: 1 };
    }
    if (sort === 'descending') {
      return { field: orderDef.field, direction: -1 };
    }
    // A field/array/object `sort` (sort-by-another-encoding, explicit domain
    // order, …) isn't interpreted here.
    addPartialGap();
    return undefined;
  }

  // A field-less aggregate (`{aggregate: 'count'}`), a datum def, etc. — no
  // per-slice value to read from the (post-aggregation) rows.
  addPartialGap();
  return undefined;
}

/** Compares two `order`-field values numerically when both are numbers, else lexicographically. */
function compareOrderValues(a: unknown, b: unknown): number {
  const aNumber = toNumber(a);
  const bNumber = toNumber(b);
  if (aNumber != null && bNumber != null) {
    return aNumber - bNumber;
  }
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** Vega-Lite's `mark.padAngle` is in radians; x-charts' `paddingAngle` is in degrees. */
const DEGREES_PER_RADIAN = 180 / Math.PI;

export function compileArcMark(ctx: UnitContext): CompiledUnit {
  const { encoding, rows, gaps, unit } = ctx;
  const { path, mark } = unit;

  // theta2/radius/radius2 describe radial ranges/offsets that x-charts' pie
  // series (a single inner/outer radius per series) cannot express.
  for (const channel of ['theta2', 'radius', 'radius2'] as const) {
    if (encoding[channel] !== undefined) {
      gaps.add({
        code: `encoding:arc-${channel}`,
        message: `The \`${channel}\` channel has no equivalent on x-charts' pie series (a single inner/outer radius per series); it was ignored.`,
        severity: 'unsupported',
        path: `${path}.encoding.${channel}`,
      });
    }
  }

  if (
    encoding.text !== undefined &&
    !Array.isArray(encoding.text) &&
    (encoding.text as { condition?: unknown }).condition !== undefined
  ) {
    // Same convention as compile/color.ts's color-condition handling: the
    // base field/value is used, the condition branches are dropped.
    gaps.add({
      code: 'encoding:arc-text-condition',
      message:
        'Conditional `text` encodings (`condition`) are not translated; the base `field`/`value` drives the arc labels and the condition branches were dropped.',
      severity: 'unsupported',
      path: `${path}.encoding.text.condition`,
    });
  }

  const arcTextEncoding = readArcTextEncoding(encoding);

  // Pie slices render in `data` array order, so `order` is applied by sorting
  // the built slice data below (see `arcOrder`).
  const arcOrder = resolveArcOrder(encoding, gaps, path);

  // Resolve the theta (slice value) channel. Aggregation is already folded
  // into a synthetic field on `encoding.theta` by the pipeline, so a plain
  // field read is enough here.
  const thetaDef = encoding.theta;
  let thetaField: string | undefined;
  let staticThetaValue: number | undefined;

  if (thetaDef && !Array.isArray(thetaDef)) {
    if (isFieldDef(thetaDef)) {
      thetaField = (thetaDef as VegaFieldDef).field;
    } else if (isDatumDef(thetaDef)) {
      staticThetaValue = toNumber(thetaDef.datum) ?? undefined;
    } else if (isValueDef(thetaDef)) {
      staticThetaValue = toNumber(thetaDef.value) ?? undefined;
    }
  }

  if (thetaField === undefined && staticThetaValue === undefined) {
    const yDef = encoding.y;
    if (
      yDef &&
      !Array.isArray(yDef) &&
      isFieldDef(yDef) &&
      // Infer the type the same way the rest of the pipeline does (an
      // explicit `type` wins, otherwise it is inferred from the data) rather
      // than requiring a literal `type: 'quantitative'` annotation.
      resolveFieldType(yDef, rows) === 'quantitative'
    ) {
      thetaField = (yDef as VegaFieldDef).field;
      gaps.add({
        code: 'mark:arc-theta-fallback-y',
        message:
          'This arc mark has no `theta` encoding; falling back to the quantitative `y` channel for slice values.',
        severity: 'partial',
        path,
      });
    }
  }

  if (thetaField === undefined && staticThetaValue === undefined) {
    gaps.add({
      code: 'mark:arc-missing-value',
      message:
        'This arc mark has neither a `theta` nor a quantitative `y` encoding to size slices from; no pie series was produced.',
      severity: 'unsupported',
      path,
    });
    return { series: [], plots: [] };
  }

  const color = resolveColor(encoding, rows, gaps, path);
  const range = color.range;
  let domain = color.domain?.map((value) => String(value));
  if (!domain && range && color.splitField) {
    // Vega-Lite infers the color domain from the data when `scale.range` is
    // given without an explicit `scale.domain`: distinct field values in
    // first-appearance (row) order, positionally matched to `range`.
    const splitField = color.splitField;
    const seen = new Set<string>();
    domain = [];
    for (const row of rows) {
      const raw = row[splitField];
      if (raw == null) {
        continue;
      }
      const key = String(raw);
      if (!seen.has(key)) {
        seen.add(key);
        domain.push(key);
      }
    }
  }

  // Decide how the `text` encoding (if any) maps onto `arcLabel`. Needs
  // `color.splitField` (drives the 'label' shortcut) and `thetaField` (drives
  // the 'value' shortcut), both resolved above.
  let arcLabelKind: 'label' | 'value' | 'field' | 'constant' | undefined;
  let arcLabelConstant: string | undefined;
  let arcLabelField: string | undefined;

  if (arcTextEncoding) {
    if ('unresolvable' in arcTextEncoding) {
      gaps.add({
        code: 'encoding:arc-text-label',
        message:
          'This `text` encoding could not be resolved to a per-slice label (e.g. a multi-line array, or a field-less aggregate like `{aggregate: "count"}` with no `field`); no `arcLabel` was set.',
        severity: 'partial',
        path: `${path}.encoding.text`,
      });
    } else if ('constant' in arcTextEncoding) {
      arcLabelKind = 'constant';
      arcLabelConstant = arcTextEncoding.constant;
    } else {
      const { field, hasFormat } = arcTextEncoding;
      arcLabelField = field;
      if (field === color.splitField) {
        arcLabelKind = 'label';
      } else if (field === thetaField) {
        arcLabelKind = 'value';
      } else {
        arcLabelKind = 'field';
      }
      if (hasFormat) {
        gaps.add({
          code: 'encoding:arc-text-label',
          message:
            'The `format` d3-format string on the `text` field is not translated; the slice label/value renders without the requested number format.',
          severity: 'partial',
          path: `${path}.encoding.text.format`,
        });
      }
    }
  }

  const textById = new Map<PieItemId, string>();
  const orderKeyByDatum = arcOrder ? new Map<PieValueType, unknown>() : undefined;
  const data: PieValueType[] = [];
  rows.forEach((row, index) => {
    const rawValue = thetaField !== undefined ? row[thetaField] : staticThetaValue;
    const value = toNumber(rawValue);
    if (value == null) {
      return;
    }
    const rawLabel = color.splitField ? row[color.splitField] : undefined;
    const label = rawLabel != null ? String(rawLabel) : undefined;

    let sliceColor: string | undefined = color.staticColor;
    if (!sliceColor && range && range.length > 0 && label !== undefined) {
      const domainIndex = domain ? domain.indexOf(label) : -1;
      sliceColor = domainIndex >= 0 ? range[domainIndex % range.length] : undefined;
    }

    const id: PieItemId = label ?? index;
    if (arcLabelKind === 'field' && arcLabelField !== undefined) {
      const rawText = row[arcLabelField];
      if (rawText != null) {
        const text = String(rawText);
        // Slice ids come from the color-field value, so un-aggregated rows
        // with duplicate categories collide on `id` — the label lookup can
        // only keep one text per id. Warn instead of silently overwriting.
        const existing = textById.get(id);
        if (existing !== undefined && existing !== text) {
          gaps.add({
            code: 'encoding:arc-text-duplicate-slice',
            message:
              "Multiple rows share the same slice identity (duplicate color-field values in un-aggregated data) but carry different `text` values; each such slice shows the last row's text. Aggregate the data so each slice maps to a single row.",
            severity: 'partial',
            path: `${path}.encoding.text`,
          });
        }
        textById.set(id, text);
      }
    }

    const datum: PieValueType = {
      id,
      value,
      label,
      ...(sliceColor ? { color: sliceColor } : {}),
    };
    data.push(datum);
    if (arcOrder && orderKeyByDatum) {
      // The order field usually survives as a group column (e.g. the color
      // field). When it doesn't — the common case where it references the
      // theta measure, whose raw column was consumed and renamed to a
      // synthetic aggregate column by the pipeline — sort by the slice's
      // aggregated `value` instead, which is what "order pie slices by that
      // measure" means.
      orderKeyByDatum.set(
        datum,
        Object.prototype.hasOwnProperty.call(row, arcOrder.field) ? row[arcOrder.field] : value,
      );
    }
  });

  if (arcOrder && orderKeyByDatum) {
    // Stable sort (per spec, JS `Array.prototype.sort` is stable) keeps the
    // original row order for slices whose `order` values tie.
    data.sort(
      (a, b) =>
        compareOrderValues(orderKeyByDatum.get(a), orderKeyByDatum.get(b)) * arcOrder.direction,
    );
  }

  if (data.length === 0 && rows.length > 0) {
    gaps.add({
      code: 'mark:arc-non-numeric-theta',
      message:
        'None of the rows produced a numeric slice value for the resolved theta field; the pie series has no slices. Check that the field contains numbers (or a numeric-producing aggregate).',
      severity: 'unsupported',
      path,
    });
  }

  const paddingAngle =
    typeof mark.padAngle === 'number' ? mark.padAngle * DEGREES_PER_RADIAN : undefined;

  let arcLabel: PieSeriesType['arcLabel'] | undefined;
  if (arcLabelKind === 'label') {
    arcLabel = 'label';
  } else if (arcLabelKind === 'value') {
    arcLabel = 'value';
  } else if (arcLabelKind === 'field') {
    // Look the per-slice text up by the slice's `id`, populated in the same
    // loop that built `data` above — covers any field, not just the ones
    // already carried on the datum via `label`/`value`.
    arcLabel = (item) => (item.id !== undefined ? textById.get(item.id) : undefined) ?? '';
  } else if (arcLabelKind === 'constant') {
    const constant = arcLabelConstant ?? '';
    arcLabel = () => constant;
  }

  const series: CompiledUnit['series'] = [
    {
      type: 'pie',
      data,
      ...(typeof mark.innerRadius === 'number' ? { innerRadius: mark.innerRadius } : {}),
      ...(typeof mark.outerRadius === 'number' ? { outerRadius: mark.outerRadius } : {}),
      ...(paddingAngle !== undefined ? { paddingAngle } : {}),
      ...(typeof mark.cornerRadius === 'number' ? { cornerRadius: mark.cornerRadius } : {}),
      ...(arcLabel !== undefined ? { arcLabel } : {}),
    },
  ];

  return { series, plots: arcLabel !== undefined ? ['pie', 'pieLabels'] : ['pie'] };
}
