import type { DatasetRow, VegaLookupTransform } from '../types';
import type { GapCollector } from '../gaps';
import { looseEquals } from './calculate';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * `lookup` joins a secondary dataset onto the primary rows: for each primary
 * row, the FIRST row in `from.data.values` whose `from.key` field equals the
 * primary row's `lookup` field value is located (first-match-wins on
 * duplicate keys, matching Vega-Lite), and fields from that match are copied
 * onto a SHALLOW CLONE of the primary row:
 *
 *  - `from.fields` given: each listed field is copied, renamed via `as`
 *    (a parallel array, or a single string when there is exactly one field)
 *    when given, otherwise kept under its original name.
 *  - `from.fields` omitted + `as` given (a single string, per the Vega-Lite
 *    schema): the ENTIRE matched row object is stored under `as`.
 *  - both omitted: this is schema-invalid in Vega-Lite, but rather than
 *    dropping the join entirely we record a 'partial' gap and merge every
 *    field of the matched row directly onto the primary row (matching
 *    Vega's own "the entire object is queried" merge behavior for `fields`).
 *
 * Non-matching rows get `default` (or `null`) written to each output field
 * that the transform statically knows about, so the output rows keep a
 * stable shape whether or not a match was found.
 *
 * The primary row's `lookup` field supports dotted-path reads (e.g.
 * `properties.name`) and — for a plain, undotted field name that isn't found
 * at the top level — falls back to `row.properties[field]`, mirroring
 * `resolveFieldValue` in marks/geoshape.ts: primary rows are often GeoJSON
 * Features when this transform feeds a choropleth. Joined fields are always
 * written at the TOP LEVEL of the (cloned) row, which is correct for
 * Features too — downstream geoshape field reads support top-level reads.
 *
 * `from.data` only supports inline `values`; `url` (remote fetch) and `name`
 * (named datasets, resolved elsewhere during spec normalization — this layer
 * has no access to them) are recorded as 'unsupported' gaps and the rows
 * pass through with default (or unchanged, when the output fields can't be
 * determined statically) values.
 */

/** Reads `field` off a primary row, supporting dotted paths and a GeoJSON-Feature `properties` fallback. */
function resolvePrimaryFieldValue(row: DatasetRow, field: string): unknown {
  const parts = field.split('.');
  let current: unknown = row;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      current = undefined;
      break;
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (current !== undefined) {
    return current;
  }
  if (parts.length === 1) {
    const properties = (row as { properties?: Record<string, unknown> }).properties;
    return properties?.[field];
  }
  return undefined;
}

/**
 * Every field name that appears on any row of the secondary dataset, other
 * than the join `key` itself (used to default unmatched rows in 'merge'
 * mode). The key is excluded because it commonly shares its name with the
 * primary row's own `lookup` field (e.g. both called `state`) — defaulting
 * it to `null` on a non-match would destroy the primary row's own value
 * rather than merely leave a joined field unset.
 */
function collectSecondaryFieldNames(secondaryRows: readonly DatasetRow[], key: string): string[] {
  const names = new Set<string>();
  secondaryRows.forEach((row) => {
    Object.keys(row).forEach((field) => {
      if (field !== key) {
        names.add(field);
      }
    });
  });
  return [...names];
}

type OutputPlan =
  | { kind: 'named'; pairs: Array<{ source: string; out: string }> }
  | { kind: 'whole'; as: string }
  | { kind: 'merge' };

/** Determines how matched (and unmatched) rows are written to, from the transform's `from.fields` / `as` shape. */
function resolveOutputPlan(
  transform: VegaLookupTransform,
  gaps: GapCollector,
  path: string,
): OutputPlan {
  const { as } = transform;
  const { fields } = transform.from;
  // Identity mapping shared by the no-`as` case and the mismatched-`as` fallbacks below.
  const identityPairs = () => fields!.map((field) => ({ source: field, out: field }));

  if (fields && fields.length > 0) {
    if (Array.isArray(as)) {
      if (as.length !== fields.length) {
        gaps.add({
          code: 'transform:lookup-as-mismatch',
          message: `The lookup transform's \`as\` array (length ${as.length}) does not match \`from.fields\` (length ${fields.length}); fields without a corresponding \`as\` entry keep their original name.`,
          severity: 'partial',
          path,
        });
      }
      return {
        kind: 'named',
        pairs: fields.map((field, index) => ({ source: field, out: as[index] ?? field })),
      };
    }
    if (typeof as === 'string') {
      if (fields.length > 1) {
        gaps.add({
          code: 'transform:lookup-as-mismatch',
          message: `The lookup transform lists multiple \`from.fields\` but a single string \`as\` ("${as}"); fields keep their original names instead of being renamed.`,
          severity: 'partial',
          path,
        });
        return { kind: 'named', pairs: identityPairs() };
      }
      return { kind: 'named', pairs: [{ source: fields[0], out: as }] };
    }
    return { kind: 'named', pairs: identityPairs() };
  }

  // `fields` omitted: per Vega-Lite, "the entire object is queried".
  if (typeof as === 'string') {
    return { kind: 'whole', as };
  }
  if (Array.isArray(as) && as.length > 0) {
    gaps.add({
      code: 'transform:lookup-as-mismatch',
      message: `The lookup transform omits \`from.fields\` but gives an array \`as\`; only a single string \`as\` is valid for a whole-row lookup. Using "${as[0]}" and ignoring the rest.`,
      severity: 'partial',
      path,
    });
    return { kind: 'whole', as: as[0] };
  }

  gaps.add({
    code: 'transform:lookup-implicit-merge',
    message:
      'The lookup transform specifies neither `from.fields` nor `as`, which is schema-invalid in Vega-Lite; all fields of the matched row are merged directly onto the primary row instead, which may silently overwrite existing fields of the same name.',
    severity: 'partial',
    path,
  });
  return { kind: 'merge' };
}

function applyPlan(
  row: DatasetRow,
  plan: OutputPlan,
  match: DatasetRow | undefined,
  defaultValue: unknown,
  mergeFieldNames: readonly string[],
  mergeKey: string,
): DatasetRow {
  const next: DatasetRow = { ...row };
  if (plan.kind === 'named') {
    plan.pairs.forEach(({ source, out }) => {
      next[out] = match ? match[source] : defaultValue;
    });
    return next;
  }
  if (plan.kind === 'whole') {
    next[plan.as] = match ? { ...match } : defaultValue;
    return next;
  }
  // 'merge': the join key is excluded (see collectSecondaryFieldNames) so it
  // doesn't clobber a primary field of the same name on a non-match.
  if (match) {
    Object.entries(match).forEach(([field, value]) => {
      if (field !== mergeKey) {
        next[field] = value;
      }
    });
  } else {
    mergeFieldNames.forEach((name) => {
      next[name] = defaultValue;
    });
  }
  return next;
}

export function applyLookupTransform(
  rows: readonly DatasetRow[],
  transform: VegaLookupTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  const { lookup, from, default: defaultValue = null } = transform;
  const { data, key } = from;
  const secondaryRows = data.values;

  if (secondaryRows === undefined) {
    if (data.url !== undefined) {
      gaps.add({
        code: 'transform:lookup-url',
        message: `The lookup transform's secondary data is loaded from \`url\` ("${data.url}"); remote data fetching is not supported, so the lookup was skipped and its output fields are left at their default.`,
        severity: 'unsupported',
        path,
      });
    } else if (data.name !== undefined) {
      gaps.add({
        code: 'transform:lookup-named-dataset',
        message: `The lookup transform references the named dataset "${data.name}"; only inline \`from.data.values\` are supported for lookups, so it was skipped and its output fields are left at their default.`,
        severity: 'unsupported',
        path,
      });
    } else {
      gaps.add({
        code: 'transform:lookup-no-data',
        message:
          "The lookup transform's `from.data` has no `values`, `url`, or `name`; the lookup was skipped and its output fields are left at their default.",
        severity: 'unsupported',
        path,
      });
    }
  }

  const plan = resolveOutputPlan(transform, gaps, path);

  if (!secondaryRows) {
    // The output field names statically known from `fields`/`as` can still be
    // defaulted so downstream consumers see a stable row shape; a 'merge'
    // plan has no statically-known field names, so rows pass through as-is.
    if (plan.kind === 'merge') {
      return rows;
    }
    return rows.map((row) => applyPlan(row, plan, undefined, defaultValue, [], key));
  }

  const mergeFieldNames =
    plan.kind === 'merge' ? collectSecondaryFieldNames(secondaryRows, key) : [];

  return rows.map((row) => {
    const primaryValue = resolvePrimaryFieldValue(row, lookup);
    // A missing/unresolvable primary value must never match: `looseEquals`
    // treats `undefined === undefined` as equal, which would otherwise
    // spuriously join a row with no lookup value to the first secondary row
    // that also happens to lack the `key` field.
    const match =
      primaryValue === undefined
        ? undefined
        : secondaryRows.find((candidate) => looseEquals(candidate[key], primaryValue));
    return applyPlan(row, plan, match, defaultValue, mergeFieldNames, key);
  });
}
