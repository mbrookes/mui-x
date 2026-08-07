import type {
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
} from '../models';
import type { StudioChartType } from '../models/baseTypes';
import { lookup } from '../utils/safeLookup';
import { findMeasureExpressionField } from './aggregate';
import { findDirectRelationship } from './dataSourceGraph';
import { effectiveFilterSourceId, resolveRowsAtGrain } from './grainResolution';
import { filterFingerprint } from './resolvedRowsCache';
import {
  captureSourceDeps,
  getLruEntry,
  getOrCreateBucket,
  setLruEntry,
  sourceDepsUnchanged,
} from './rowCacheLru';
import type { SourceDep } from './rowCacheLru';

type Row = Record<string, unknown>;

/**
 * Relationship / chart-support analysis for the chart aggregation pipeline.
 *
 * Decides whether a chart configuration (x / y / series / scatter fields) can be
 * safely aggregated given the widget's data source and the relationship graph, and
 * — when it can — resolves the widget rows to the correct fan-out-safe grain via the
 * shared L4 core (`grainResolution.resolveRowsAtGrain`).
 */

function hasRowLevelField(
  sourceId: string,
  fieldId: string,
  dataSources: Record<string, StudioDataSource>,
  expressionFields: StudioExpressionField[],
): boolean {
  const source = dataSources[sourceId];
  return (
    source?.fields.some((field) => field.id === fieldId) === true ||
    expressionFields.some(
      (field) => field.sourceId === sourceId && field.id === fieldId && !field.isMeasure,
    )
  );
}

function isSafeWidgetBridgeOwner(
  widgetSourceId: string,
  ownerSourceId: string,
  relationships: StudioRelationship[],
): boolean {
  if (ownerSourceId === widgetSourceId) {
    return true;
  }

  const relationship = findDirectRelationship(widgetSourceId, ownerSourceId, relationships);
  if (relationship) {
    if (relationship.type === 'one-to-one') {
      return true;
    }
    if (relationship.type === 'many-to-many') {
      // A M:N relationship is only actually joinable through its junction table when BOTH
      // junction fields are present — without them there's no way to resolve rows between
      // the two endpoints, matching `findJoinPath`'s completeness check
      // (`dataSourceGraph.ts:133`). Treating an incomplete junction as a safe bridge silently
      // mis-resolves the owner's rows instead of failing closed.
      return Boolean(relationship.junctionSourceField) && Boolean(relationship.junctionTargetField);
    }
    return relationship.sourceId === widgetSourceId;
  }

  // Also allow the junction source of a M:N relationship involving widgetSourceId — but only
  // when the junction is complete (both join fields present); an incomplete junction cannot
  // actually be used to resolve rows, so it must not be treated as a safe bridge.
  const viaJunction = relationships.some(
    (rel) =>
      rel.type === 'many-to-many' &&
      rel.junctionSourceId === ownerSourceId &&
      Boolean(rel.junctionSourceField) &&
      Boolean(rel.junctionTargetField) &&
      (rel.sourceId === widgetSourceId || rel.targetId === widgetSourceId),
  );
  return viaJunction;
}

/**
 * True when `ownerSourceId` is reachable from `widgetSourceId` via a many-to-many relationship —
 * either as its remote endpoint (the direct relationship is `many-to-many`) or as its junction
 * source. This is exactly the fan-out topology that has no single grain when the chart anchors on a
 * DIFFERENT directly-related many side: the dimension fans out across the M:N link
 * while the measure lives on an unrelated many-side anchor. Note a `viaJunction` remote/junction
 * owner is only flagged when NO safe direct (M:1/O:O) relationship exists — `findDirectRelationship`
 * returning a non-M:N relationship means the owner is bridgeable the ordinary way and must not fail.
 */
function isManyToManyReachableOwner(
  widgetSourceId: string,
  ownerSourceId: string,
  relationships: StudioRelationship[],
): boolean {
  const direct = findDirectRelationship(widgetSourceId, ownerSourceId, relationships);
  if (direct) {
    // Only a COMPLETE M:N relationship (both junction fields present) is actually reachable through
    // the junction table — matching `findJoinPath`'s completeness check (`dataSourceGraph.ts:133`).
    return (
      direct.type === 'many-to-many' &&
      Boolean(direct.junctionSourceField) &&
      Boolean(direct.junctionTargetField)
    );
  }
  return relationships.some(
    (rel) =>
      rel.type === 'many-to-many' &&
      rel.junctionSourceId === ownerSourceId &&
      Boolean(rel.junctionSourceField) &&
      Boolean(rel.junctionTargetField) &&
      (rel.sourceId === widgetSourceId || rel.targetId === widgetSourceId),
  );
}

function findDirectFieldOwner(
  widgetSourceId: string,
  fieldId: string,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
): string | null {
  if (hasRowLevelField(widgetSourceId, fieldId, dataSources, expressionFields)) {
    return widgetSourceId;
  }

  // Check direct (one-hop) relationships first
  for (const relationship of relationships) {
    if (relationship.type === 'many-to-many') {
      continue;
    }
    let relatedSourceId: string | null = null;

    if (relationship.sourceId === widgetSourceId) {
      relatedSourceId = relationship.targetId;
    } else if (relationship.targetId === widgetSourceId) {
      relatedSourceId = relationship.sourceId;
    }

    if (
      relatedSourceId &&
      hasRowLevelField(relatedSourceId, fieldId, dataSources, expressionFields)
    ) {
      return relatedSourceId;
    }
  }

  // Check many-to-many two-hop (field on the remote endpoint source or the junction source itself)
  for (const relationship of relationships) {
    if (relationship.type !== 'many-to-many') {
      continue;
    }
    // A M:N relationship is only usable as a two-hop bridge when BOTH junction fields are
    // present — without them there's no way to join the junction table to either endpoint,
    // matching `findJoinPath`'s completeness check (`dataSourceGraph.ts:133`). An incomplete
    // junction must not be treated as resolving the field's owner.
    if (
      !relationship.junctionSourceId ||
      !relationship.junctionSourceField ||
      !relationship.junctionTargetField
    ) {
      continue;
    }

    // Check junction source itself
    if (hasRowLevelField(relationship.junctionSourceId, fieldId, dataSources, expressionFields)) {
      if (relationship.sourceId === widgetSourceId || relationship.targetId === widgetSourceId) {
        return relationship.junctionSourceId;
      }
    }

    // Check remote endpoint
    let remoteSourceId: string | null = null;
    if (relationship.sourceId === widgetSourceId) {
      remoteSourceId = relationship.targetId;
    } else if (relationship.targetId === widgetSourceId) {
      remoteSourceId = relationship.sourceId;
    }

    if (
      remoteSourceId &&
      hasRowLevelField(remoteSourceId, fieldId, dataSources, expressionFields)
    ) {
      return remoteSourceId;
    }
  }

  return null;
}

/**
 * Which chart families can render a MEASURE expression field (`isMeasure: true`) as their
 * y-measure.
 *
 * A measure has NO per-row value — `enrichRowsWithExpressions` deliberately skips measures, so
 * `row[measureId]` is `undefined` on every row. It can only be produced by evaluating the whole
 * expression over each bucket's ROW SET (`internals/aggregate.resolveMeasureAggregate`). A family
 * therefore supports a measure exactly when its aggregation path keeps the contributing rows per
 * bucket:
 *
 * - `true` — bar / line / area / pie / donut / mixed route through the three generic aggregators
 *   (`aggregators.ts`), which all take `expressionFields` and evaluate a measure per bucket; gauge
 *   evaluates it over the whole row set in `renderGauge` (`chartTypeDefs.tsx`), exactly like the
 *   KPI card does. Heatmap / funnel / sankey aggregate through the `internals/chartShapes/*`
 *   reducers, which now bucket rows per cell / stage / (source, target) pair and evaluate the
 *   measure over each bucket through the same shared `resolveMeasureAggregate`.
 * - `false` — scatter plots RAW per-row coordinates, so a value that only exists per bucket has
 *   no coordinate to plot at all; gantt likewise reads raw per-row start/end/label values. These
 *   two are not a missing implementation but a property of the families: they have no buckets to
 *   aggregate a measure over.
 *
 * Offering a measure to a `false` family is what the `'measure_not_supported'` reason exists to
 * report: without it the picker offered every measure everywhere and the chart then drew a
 * confident, wrong result (or nothing) with no explanation. `satisfies Record<StudioChartType, …>`
 * makes answering the question a compile-time requirement for any new chart type.
 */
export const CHART_TYPE_MEASURE_SUPPORT = {
  bar: true,
  'bar-stacked': true,
  'bar-100': true,
  line: true,
  area: true,
  'area-stacked': true,
  'area-100': true,
  pie: true,
  donut: true,
  mixed: true,
  gauge: true,
  heatmap: true,
  funnel: true,
  sankey: true,
  scatter: false,
  gantt: false,
} satisfies Record<StudioChartType, boolean>;

/**
 * Whether `chartType` can evaluate a measure expression field as its y-measure.
 *
 * `undefined` answers `true`: the non-chart callers (`resolveChartRowsForAggregation`'s internal
 * re-check, the KPI widget's grain analysis) pass no chart type and must not have a chart-family
 * restriction applied to them. An UNKNOWN (doc/AI-authored) chart type answers `false` — fail
 * closed, and read through the prototype-chain-safe `lookup` so a key like `"constructor"` can't
 * resolve an inherited truthy member off `Object.prototype`.
 */
export function chartTypeSupportsMeasure(chartType: string | undefined): boolean {
  if (chartType === undefined) {
    return true;
  }
  return lookup(CHART_TYPE_MEASURE_SUPPORT, chartType) ?? false;
}

export type ChartSupportReason =
  | 'field_not_found_or_not_direct'
  | 'mixed_cross_source_fields'
  | 'scatter_cross_source_not_supported'
  | 'measure_not_supported';

export interface ChartSupportResult {
  supported: boolean;
  reason?: ChartSupportReason;
  /** Precomputed field → owning sourceId mapping (only present when supported=true). */
  fieldOwners?: Map<string, string>;
  /** Precomputed anchor source for aggregation (only present when supported=true). */
  anchorSourceId?: string;
}

export function getChartSupportMessage(reason: ChartSupportReason): string {
  switch (reason) {
    case 'field_not_found_or_not_direct':
      return 'This chart configuration uses fields that are not available on the widget source or a directly related source.';
    case 'mixed_cross_source_fields':
      return 'This chart configuration mixes cross-source fields in a way that does not have a single safe aggregation grain yet.';
    case 'scatter_cross_source_not_supported':
      return 'Scatter charts do not support cross-source field combinations yet.';
    // Kept verbatim in sync with `localeText.chartUnsupportedMeasure` — this English string is
    // what non-localized callers (AI insight generation, tests) read, while the two UI surfaces
    // (`StudioChartWidget`, `ChartSetupPanel`) render the locale key. Since heatmap / funnel /
    // sankey gained a measure path, only TWO situations still reach this reason, and the wording
    // names both: a measure placed in a DIMENSION slot (any family), and a measure on scatter /
    // gantt, which plot one mark per raw row and so have no bucket to evaluate it over.
    case 'measure_not_supported':
      return 'A measure field has no per-row value, so it can only be a chart value — never a category axis, split-by, colour or size — and scatter and Gantt charts, which plot one mark per raw row, cannot use one at all.';
    default:
      return 'This chart configuration is not supported yet.';
  }
}

export function analyzeChartSupport(
  widgetSourceId: string | undefined,
  xField: string | undefined,
  yFields: string[],
  seriesField: string | undefined,
  chartType: string | undefined,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[] = [],
  scatterColorField?: string,
  scatterSizeField?: string,
  /**
   * Additional dimension-like fields a non-xy chart family reads but that are not
   * expressed via x / y / series (e.g. heatmap `heatYField`, sankey `sankeyTargetField`,
   * funnel `funnelReachedField`, the `gantt*` fields). Validated / grain-resolved exactly
   * like `seriesField` — never treated as a y-measure.
   */
  extraFields: (string | undefined)[] = [],
): ChartSupportResult {
  const requestedFields = [
    xField,
    ...yFields,
    seriesField,
    scatterColorField,
    scatterSizeField,
    ...extraFields,
  ].filter((field): field is string => Boolean(field));

  if (!widgetSourceId || requestedFields.length === 0) {
    return { supported: true };
  }

  const yFieldSet = new Set(yFields);

  // ── Measure expression fields ──────────────────────────────────────────────
  //
  // A measure has no per-row value, so it can never be resolved by `findDirectFieldOwner`
  // (`hasRowLevelField` explicitly excludes measures) and must never reach L4 re-anchoring —
  // there is no column to join or enrich. Classify them up front instead: a measure that IS
  // usable here is dropped from `requestedFields`/`fieldOwners` entirely (so L4 treats it as
  // absent), and one that is NOT usable fails closed with a reason that names the real problem.
  //
  // Before this, EVERY measure fell through to `field_not_found_or_not_direct` — "fields that are
  // not available on the widget source", said about a measure the panel had just offered and the
  // KPI card beside it was already computing correctly. The measure-aware generic aggregators
  // (`aggregators.ts`) were unreachable from charts as a result.
  const measureYFields = new Set<string>();
  for (const fieldId of requestedFields) {
    const measure = findMeasureExpressionField(fieldId, expressionFields);
    if (!measure) {
      continue;
    }
    // A measure is a MEASURE and nothing else: it can never group, split, colour or size, because
    // those dimensions read a per-row value that does not exist. Any non-y slot fails closed.
    if (!yFieldSet.has(fieldId)) {
      return { supported: false, reason: 'measure_not_supported' };
    }
    if (!chartTypeSupportsMeasure(chartType)) {
      return { supported: false, reason: 'measure_not_supported' };
    }
    // A measure is evaluated over the WIDGET's own rows. A measure owned by another source would
    // need that source's rows at that source's grain, which this analysis never produces — the
    // same "not available on the widget source" answer the pre-existing owner lookup gives for
    // any unreachable field.
    if (measure.sourceId !== widgetSourceId) {
      return { supported: false, reason: 'field_not_found_or_not_direct' };
    }
    measureYFields.add(fieldId);
  }

  const fieldOwners = new Map<string, string>();
  for (const fieldId of requestedFields) {
    if (measureYFields.has(fieldId)) {
      // Deliberately absent from `fieldOwners`: `resolveRowsAtGrain` routes every entry through
      // its enrichment/expansion joins, and a measure has no column for those to read.
      continue;
    }
    const owner = findDirectFieldOwner(
      widgetSourceId,
      fieldId,
      dataSources,
      relationships,
      expressionFields,
    );
    if (!owner) {
      return { supported: false, reason: 'field_not_found_or_not_direct' };
    }
    fieldOwners.set(fieldId, owner);
  }

  if (
    chartType === 'scatter' &&
    Array.from(fieldOwners.values()).some((owner) => owner !== widgetSourceId)
  ) {
    return { supported: false, reason: 'scatter_cross_source_not_supported' };
  }

  const ySourceIds = [
    ...new Set(
      yFields
        .map((fieldId) => fieldOwners.get(fieldId))
        .filter((sourceId): sourceId is string => Boolean(sourceId)),
    ),
  ];

  let anchorSourceId = widgetSourceId;
  // Set only when we junction-anchor purely to fan a WIDGET-owned measure out across an
  // M:N remote dimension. It relaxes the y-owner check below: in that topology
  // the measure legitimately lives on the widget source, not on the (junction) anchor.
  let junctionAnchorForWidgetMeasure = false;
  // Set only when the anchor is a plain many-to-one anchor (widget is the "one" side, anchor is a
  // directly-related MANY side — NOT the widget itself, NOT an M:N junction). In that topology a
  // grouping dimension owned by the remote endpoint / junction of an M:N relationship with the
  // widget has no single grain combining it with the many-side measure, so it must fail closed
  // rather than be silently mis-attributed by the first-match-only M:N display lookup.
  let anchorIsPlainManyToOne = false;
  // Set only when the anchor is the JUNCTION source of an M:N relationship because the measure
  // (y) is a field owned by the junction table itself (`viaJunctionRel` below) — as opposed to
  // `junctionAnchorForWidgetMeasure`, where the measure lives on the widget source. In that
  // topology a grouping dimension owned by a DIFFERENT M:N relationship's remote endpoint (or
  // junction) has no single grain combining it with this junction-owned measure: it would
  // silently be resolved via `enrichRowsWithRelatedFields`'s first-match-only two-hop lookup
  // instead of actually fanning out, mis-attributing links. A dimension owned by
  // THIS SAME relationship's own remote endpoint is fine — `resolveRowsAtGrain`'s M:N branch
  // already joins that endpoint in as part of the merge — so only a DIFFERENT M:N relationship's
  // reach is disallowed (tracked via `anchorJunctionRemoteSourceId` below).
  let anchorIsJunctionOwnedMeasure = false;
  let anchorJunctionRemoteSourceId: string | undefined;
  if (ySourceIds.length === 1 && ySourceIds[0] !== widgetSourceId) {
    const ySourceId = ySourceIds[0];
    const anchorRelationship = findDirectRelationship(widgetSourceId, ySourceId, relationships);
    if (anchorRelationship) {
      // A one-to-one relationship has no fan-out in EITHER direction (each side has at most one
      // matching row), so which side was declared `sourceId` vs `targetId` is irrelevant to
      // safety — anchoring on `ySourceId` is fine regardless of direction, matching the
      // direction-independent check `isSafeWidgetBridgeOwner` already applies to a 1:1 owner. The
      // anchor-selection check here used to require the SAME direction a many-to-one relationship
      // uses (`sourceId === ySourceId && targetId === widgetSourceId`) for a 1:1 too, so a 1:1
      // declared the other way around fell through to no anchor switch and failed closed even
      // though the identical relationship declared in reverse was accepted — a schema-author-facing
      // inconsistency, not a correctness bug, since the reverse-declared case failed closed rather
      // than mis-aggregating. `anchorIsPlainManyToOne` (which gates the M:N-reachable-
      // dimension fail-closed guard below) still applies to a 1:1 anchor in either direction, same
      // as it always did for the forward direction: a 1:1 anchor has no fan-out risk of its OWN,
      // but combining it with a first-match-only M:N-reachable dimension has the identical
      // silent-mis-attribution risk a plain many-to-one anchor does, so the guard's
      // applicability is unchanged — only the anchor-selection direction check is widened.
      const widgetIsOneSide =
        anchorRelationship.sourceId === ySourceId && anchorRelationship.targetId === widgetSourceId;
      const oneToOneReverseDirection =
        anchorRelationship.type === 'one-to-one' &&
        anchorRelationship.sourceId === widgetSourceId &&
        anchorRelationship.targetId === ySourceId;
      if (
        anchorRelationship.type !== 'many-to-many' &&
        (widgetIsOneSide || oneToOneReverseDirection)
      ) {
        // many-to-one: widget is the "one" side → anchor on the "many" (ySource). One-to-one:
        // either declaration direction anchors safely on ySourceId.
        anchorSourceId = ySourceId;
        anchorIsPlainManyToOne = true;
      } else if (
        anchorRelationship.type === 'many-to-many' &&
        anchorRelationship.junctionSourceId &&
        anchorRelationship.junctionSourceField &&
        anchorRelationship.junctionTargetField
      ) {
        // many-to-many: anchor on the junction table — one row per (widget, target) pair.
        // Both junction fields must be present to actually perform the join;
        // if either is missing, leave `anchorSourceId` at its default (widgetSourceId) so the
        // per-field owner loop below fails closed with `mixed_cross_source_fields` instead of
        // silently anchoring on a junction table with no usable join fields.
        anchorSourceId = anchorRelationship.junctionSourceId;
      }
    } else {
      // No direct relationship — check if ySourceId IS the junction source of a M:N rel
      const viaJunctionRel = relationships.find(
        (rel) =>
          rel.type === 'many-to-many' &&
          rel.junctionSourceId === ySourceId &&
          rel.junctionSourceField &&
          rel.junctionTargetField &&
          (rel.sourceId === widgetSourceId || rel.targetId === widgetSourceId),
      );
      if (viaJunctionRel) {
        // y-field lives directly in the junction table; anchor on the junction itself
        anchorSourceId = ySourceId;
        anchorIsJunctionOwnedMeasure = true;
        anchorJunctionRemoteSourceId =
          viaJunctionRel.sourceId === widgetSourceId
            ? viaJunctionRel.targetId
            : viaJunctionRel.sourceId;
      }
    }
  } else if (ySourceIds.every((sourceId) => sourceId === widgetSourceId)) {
    // All measures are widget-owned (or there are none — a fieldless "count" chart). If a
    // grouping DIMENSION (x / series / extra) is owned by the remote endpoint (or the junction
    // itself) of a many-to-many relationship with the widget source, the widget grain fans out
    // across that M:N link. Leaving `anchorSourceId = widgetSourceId` here routes L4 through
    // `enrichRowsWithRelatedFields`, whose M:N path is first-match-only — it attaches a single
    // arbitrary junction link per widget row and silently discards the rest, so
    // "sum of order total by tag" attributes each order to only ONE of its tags.
    // Anchor on the M:N junction instead: `resolveRowsAtGrain`'s M:N branch expands each widget
    // row into one row per matching junction entry (merging widget + remote + junction fields),
    // so the widget-owned measure is correctly fanned out across every linked remote value.
    const junctionAnchors = new Set<string>();
    for (const [fieldId, owner] of fieldOwners) {
      if (yFieldSet.has(fieldId) || owner === widgetSourceId) {
        continue;
      }
      // Both junction fields must be present to actually perform the join —
      // an M:N relationship missing either field cannot resolve `owner`'s rows back to the
      // widget grain, so it must not be selected as a usable junction anchor here.
      const mnRel = relationships.find(
        (rel) =>
          rel.type === 'many-to-many' &&
          !!rel.junctionSourceId &&
          !!rel.junctionSourceField &&
          !!rel.junctionTargetField &&
          ((rel.sourceId === widgetSourceId &&
            (rel.targetId === owner || rel.junctionSourceId === owner)) ||
            (rel.targetId === widgetSourceId &&
              (rel.sourceId === owner || rel.junctionSourceId === owner))),
      );
      if (mnRel?.junctionSourceId) {
        junctionAnchors.add(mnRel.junctionSourceId);
      }
    }
    if (junctionAnchors.size === 1) {
      [anchorSourceId] = junctionAnchors;
      junctionAnchorForWidgetMeasure = true;
    } else if (junctionAnchors.size > 1) {
      // Dimensions on two different M:N remote endpoints have no single junction grain.
      return { supported: false, reason: 'mixed_cross_source_fields' };
    }
  }

  if (
    anchorSourceId === widgetSourceId &&
    ySourceIds.filter((sourceId) => sourceId !== widgetSourceId).length > 1
  ) {
    return { supported: false, reason: 'mixed_cross_source_fields' };
  }

  // A measure expression is written against the WIDGET source's rows at the widget's own grain
  // (that is the row set `evaluateMeasure` is handed, and the row set the KPI card evaluates it
  // over). Any re-anchor — a many-to-one anchor for a sibling cross-source measure, or an M:N
  // junction anchor selected to fan a dimension out — hands the aggregators a row set that has
  // been expanded or re-grained, so the same measure would silently return a different number
  // here than on the KPI beside it. There is no combined grain, so fail closed rather than
  // publish two answers to one question.
  if (measureYFields.size > 0 && anchorSourceId !== widgetSourceId) {
    return { supported: false, reason: 'mixed_cross_source_fields' };
  }

  for (const [fieldId, owner] of fieldOwners.entries()) {
    if (yFieldSet.has(fieldId)) {
      // The measure must live on the anchor grain so a per-row aggregation can't double count.
      // Exception: a widget-owned measure under a junction anchor selected purely to fan it out
      // across an M:N remote dimension — the expansion join reads it from the
      // merged widget row, one clean copy per junction link, which is the intended join semantic.
      const measureOwnerOk =
        owner === anchorSourceId || (junctionAnchorForWidgetMeasure && owner === widgetSourceId);
      if (!measureOwnerOk) {
        return { supported: false, reason: 'mixed_cross_source_fields' };
      }
      continue;
    }

    if (owner === anchorSourceId) {
      continue;
    }

    // Under a plain many-to-one anchor (the measure lives on a
    // directly-related many side, distinct from the widget source), a grouping dimension owned by
    // the remote endpoint or junction of an M:N relationship with the widget has no single grain.
    // `isSafeWidgetBridgeOwner` would wave it through and `resolveRowsAtGrain`'s many-to-one branch
    // would then resolve it via `enrichRowsWithRelatedFields`'s first-match-only junction lookup —
    // attributing each widget row's measure to ONE arbitrary link (or, for a junction-OWNED
    // dimension, reading `undefined` for every row). Iteration 7's junction-anchor fix only covered
    // widget-owned measures; this branch's measure is NOT widget-owned and NOT on the dimension's
    // M:N relationship, so there is genuinely no combined grain — fail closed, matching the existing
    // "two distinct M:N remote dimensions" behaviour.
    if (
      anchorIsPlainManyToOne &&
      isManyToManyReachableOwner(widgetSourceId, owner, relationships)
    ) {
      return { supported: false, reason: 'mixed_cross_source_fields' };
    }

    // Under a JUNCTION-OWNED-MEASURE anchor (the measure is a field on the junction
    // table itself), a grouping dimension reachable via a DIFFERENT M:N relationship's remote
    // endpoint or junction has no single grain combining it with this anchor either — the same
    // risk as the plain-many-to-one case above, just one hop further out. `anchorIsPlainManyToOne`
    // never fires for this shape (the anchor here isn't a plain many-to-one relationship), so
    // without this check `isSafeWidgetBridgeOwner` waves the dimension through (it only checks
    // whether SOME M:N relationship reaches `owner` from the widget, not whether it's the SAME
    // relationship the anchor is grained on) and `resolveRowsAtGrain`'s M:N branch resolves the
    // dimension via `enrichRowsWithRelatedFields`'s first-match-only two-hop lookup — silently
    // mis-attributing links instead of failing closed. A dimension owned by THIS anchor
    // relationship's own remote endpoint (`anchorJunctionRemoteSourceId`) is unaffected — that
    // endpoint is already correctly joined in by the M:N branch's own merge.
    if (
      anchorIsJunctionOwnedMeasure &&
      owner !== anchorJunctionRemoteSourceId &&
      isManyToManyReachableOwner(widgetSourceId, owner, relationships)
    ) {
      return { supported: false, reason: 'mixed_cross_source_fields' };
    }

    if (!isSafeWidgetBridgeOwner(widgetSourceId, owner, relationships)) {
      return { supported: false, reason: 'mixed_cross_source_fields' };
    }
  }

  return { supported: true, fieldOwners, anchorSourceId };
}

// ─── resolveChartRowsForAggregation cache ──────────────────────────────────────
//
// Two-level WeakMap: widgetRows × anchorRows → configKey → Row[]
//
// Why two levels are needed (context): The old single-level cachedCompute(widgetRows, configKey)
// relied on resolvedRowsCache always producing a NEW widgetRows ref whenever ANY dataSources
// changed (via module-wide sentinels). After we fixed resolvedRowsCache to be per-source, unrelated
// source changes no longer affect widgetRows — which is correct for the filter layer but breaks the
// assumption here for cross-source charts.
//
// Example failure with single-level cache:
//   - Chart on order_items, Y = orders.amount  (orders is the grain-anchor)
//   - orders.rows is refreshed → order_items.filteredRows unchanged
//   - cachedCompute(filteredRows, configKey) → hit → stale orders data shown 🐛
//
// Fix: add anchorRows as a second WeakMap level.
//   - widgetRows changes   → outer miss → recompute ✓
//   - anchorRows changes   → inner miss → recompute ✓
//   - same config, same data → both hit  → O(1) ✓
//   - unrelated source changes → neither key changes → still hits ✓
//
// Row references alone are not enough: editing a relationship's join fields or an
// anchor/widget-source expression formula changes the joined/re-anchored result
// while every row array ref stays the same. The entry therefore also tracks the
// `relationships` array ref and the object refs of the expression fields relevant
// to this call (those owned by the widget/anchor/field-owner sources), and is
// invalidated when either changes.
//
// The widgetRows (outer key) and anchorRows (inner key) cover only the widget source and the
// grain anchor, but `resolveRowsAtGrain` also reads rows from OTHER foreign sources —
// display/dimension-field enrichment joins, the many-to-many remote endpoint, and
// join-field-expression targets — none of which is captured by the two WeakMap keys. Their
// rows changing would otherwise serve a stale re-anchored result. The entry
// therefore records the `SourceDep` (rows AND fields) of every such foreign source (reported by
// `resolveRowsAtGrain` via its `collectReadSourceIds` out-param) and invalidates when either ref
// changes: those sources are read through `getCachedNormalizedDataSource`, which is keyed on
// both, so retyping a foreign field changes the re-anchored values while its rows ref stays
// identical — chart buckets would otherwise keep splitting on a value the rest of the dashboard
// has already canonicalized.
//
// A WeakMap key is NOT a substitute for a `SourceDep` — it pins `rows` only. So the widget and
// anchor sources are tracked as deps as well, precisely because the anchor's rows are themselves
// read through `getCachedNormalizedDataSource`: a retype leaves both WeakMap keys identical and
// only the `fields` ref moves.
//
// The innermost `Map` is capped through the shared insertion-order LRU in `rowCacheLru.ts`, like
// the three row caches: `configKey` is derived from widget config (x/y/series/extra fields plus
// the anchor-scoped filter fingerprint), which churns on every chart-config edit while the rows
// arrays stay alive, and each entry pins a full re-anchored result array.
interface RcfaEntry {
  relationships: StudioRelationship[];
  exprFields: StudioExpressionField[];
  /**
   * Rows AND fields refs of every source this result read — the foreign ones reported via
   * `collectReadSourceIds`, PLUS the widget and anchor sources. The latter two are not
   * redundant with the WeakMap keys: a key covers only `rows`, while the anchor rows are read
   * through `getCachedNormalizedDataSource` (keyed on rows AND fields), so a retype that keeps
   * `rows` identical must invalidate here or nowhere.
   */
  readSourceDeps: Map<string, SourceDep>;
  result: Row[];
}
const rcfaCache = new WeakMap<Row[], WeakMap<Row[], Map<string, RcfaEntry>>>();

/** Non-measure expression fields owned by any of `sourceIds`, in declaration order. */
function collectRelevantExprFields(
  expressionFields: StudioExpressionField[],
  sourceIds: ReadonlySet<string>,
): StudioExpressionField[] {
  return expressionFields.filter((ef) => !ef.isMeasure && sourceIds.has(ef.sourceId));
}

/** Reference-equality comparison of two expression-field lists (same objects, order, length). */
function exprFieldsRefEqual(a: StudioExpressionField[], b: StudioExpressionField[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function resolveChartRowsForAggregation(
  widgetRows: Row[],
  widgetSourceId: string | undefined,
  xField: string | undefined,
  yFields: string[],
  seriesField: string | undefined,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[] = [],
  /**
   * Dimension-like fields a non-xy chart family reads but that aren't expressed via x/y/series
   * (heatmap `heatYField`, funnel `funnelReachedField`, sankey `sankeyTargetField`, the `gantt*`
   * fields). They must be threaded into the L4 requested-field set (and cache key) so a
   * one-hop cross-source extra dimension is enriched onto the returned rows instead of reading
   * `undefined` — the guard already reports such a field as SUPPORTED.
   */
  extraFields: (string | undefined)[] = [],
  /**
   * The widget's fully resolved/scoped filter set (page + widget + cross-filter + interactive —
   * exactly what L3 used to produce `widgetRows`). Only the subset targeting the anchor source
   * is applied to the anchor rows before the expansion join (see `resolveRowsAtGrain`) — without
   * it, a filter on an anchor-source field that L3 enforced as a semi-join gets silently
   * re-widened back to every anchor row for each surviving widget row. Folded into
   * the cache key below so a filter edit invalidates the cached re-anchored result.
   */
  widgetFilters: StudioFilterState[] = [],
): Row[] {
  const cleanExtraFields = extraFields.filter((field): field is string => Boolean(field));
  const requestedFields = [xField, ...yFields, seriesField, ...cleanExtraFields].filter(
    (field): field is string => Boolean(field),
  );

  if (!widgetSourceId || widgetRows.length === 0 || requestedFields.length === 0) {
    return widgetRows;
  }

  // Determine anchor source first (cheap — O(fields × relationships)).
  // This must happen before the cache lookup so we know the second WeakMap key.
  // `extraFields` are passed so their owners land in `fieldOwners` and are grain-resolved.
  const support = analyzeChartSupport(
    widgetSourceId,
    xField,
    yFields,
    seriesField,
    undefined,
    dataSources,
    relationships,
    expressionFields,
    undefined,
    undefined,
    extraFields,
  );

  if (!support.supported) {
    return [];
  }

  const anchorSourceId = support.anchorSourceId ?? widgetSourceId;
  // For cross-source grain anchor: outer key = widgetRows, inner key = anchorRows.
  // For same-source: inner key = widgetRows itself (collapses to single-level semantics).
  const anchorRows =
    anchorSourceId !== widgetSourceId
      ? (dataSources[anchorSourceId]?.rows ?? widgetRows)
      : widgetRows;

  // Two-level WeakMap lookup
  let byAnchor = rcfaCache.get(widgetRows);
  if (!byAnchor) {
    byAnchor = new WeakMap();
    rcfaCache.set(widgetRows, byAnchor);
  }
  const byKey = getOrCreateBucket(byAnchor, anchorRows);

  // Reuse fieldOwners precomputed by analyzeChartSupport — no need to traverse
  // the relationship graph again (O(fields × relationships) saved per call).
  const fieldOwners = support.fieldOwners ?? new Map<string, string>();

  // Expression fields whose formula changes must invalidate this joined result:
  // those owned by the widget source, the anchor source, or any field owner.
  const relevantExprSourceIds = new Set<string>([widgetSourceId, anchorSourceId]);
  for (const owner of fieldOwners.values()) {
    relevantExprSourceIds.add(owner);
  }
  const relevantExprFields = collectRelevantExprFields(expressionFields, relevantExprSourceIds);

  // The anchor-scoped filter subset affects `resolveRowsAtGrain`'s output; so does
  // the subset scoped to the M:N REMOTE endpoint when the anchor is a many-to-many junction —
  // those are re-applied to the remote rows before the expansion join. Fold both
  // fingerprints into the cache key so editing/adding/removing either invalidates the entry
  // instead of serving a stale re-anchored result.
  const anchorScopeSourceIds = new Set<string>([anchorSourceId]);
  const mnRelForAnchor = relationships.find(
    (rel) =>
      rel.type === 'many-to-many' &&
      rel.junctionSourceId === anchorSourceId &&
      (rel.sourceId === widgetSourceId || rel.targetId === widgetSourceId),
  );
  if (mnRelForAnchor) {
    anchorScopeSourceIds.add(
      mnRelForAnchor.sourceId === widgetSourceId
        ? mnRelForAnchor.targetId
        : mnRelForAnchor.sourceId,
    );
  }
  // Derive each filter's effective source the same way `resolveRowsAtGrain` does, so a drawer
  // filter on an anchor/remote-owned EXPRESSION field (no explicit `filterSourceId`) is folded into
  // the key too — otherwise editing/adding such a filter would serve a stale re-anchored result.
  //
  const anchorScopedFilterKey = widgetFilters
    .filter((f) => {
      const effectiveSourceId = effectiveFilterSourceId(f, widgetSourceId, expressionFields);
      return effectiveSourceId != null && anchorScopeSourceIds.has(effectiveSourceId);
    })
    .map(filterFingerprint)
    .sort()
    .join('|');

  const configKey = `rcfa:${widgetSourceId}|${xField ?? ''}|${yFields.join(',')}|${seriesField ?? ''}|${cleanExtraFields.join(',')}|${anchorScopedFilterKey}`;
  // `getLruEntry` refreshes recency on read, so the config a widget is actively rendering is
  // never the eviction candidate.
  const cached = getLruEntry(byKey, configKey);
  if (
    cached &&
    cached.relationships === relationships &&
    exprFieldsRefEqual(cached.exprFields, relevantExprFields) &&
    sourceDepsUnchanged(cached.readSourceDeps, dataSources)
  ) {
    return cached.result;
  }

  // Re-anchor the row set to the fan-out anchor's grain (shared L4 core, see
  // internals/grainResolution.ts) so a plain per-row aggregation cannot
  // double-count from a fan-out join. `resolveRowsAtGrain` reports (via the out-param) every
  // foreign source whose rows it read that is NOT the widget/anchor source, so those row refs
  // can be folded into the cache-validity check above.
  const readSourceIds = new Set<string>();
  const result = resolveRowsAtGrain(
    widgetRows,
    widgetSourceId,
    anchorSourceId,
    requestedFields,
    fieldOwners,
    dataSources,
    relationships,
    expressionFields,
    readSourceIds,
    widgetFilters,
  );

  // The widget and anchor sources are tracked HERE TOO, not skipped as "already covered by the
  // two WeakMap keys" — those keys cover only each source's `rows`, and a `SourceDep` covers
  // `rows` AND `fields`. The anchor rows are read through `getCachedNormalizedDataSource`
  // (`grainResolution`'s many-to-one anchor and M:N junction-anchor branches), whose output
  // depends on both, so retyping an anchor field via `updateDataSourceField` — which commits a
  // new `fields` array while leaving `rows` reference-identical — changed the re-anchored values
  // with nothing in the validity check noticing: outer key unchanged, inner key unchanged,
  // `relationships`/expression fields unchanged, and the anchor was filtered out of
  // `readSourceDeps`. The chart went on bucketing `'1/15/2024'` forever while the grid beside it
  // showed the canonicalized `'2024-01-15'`, with no recovery short of replacing the anchor's
  // rows. This is the same class the non-anchor `readSourceDeps` fixed; the anchor
  // was simply not in the tracked set. The widget source is included for the same reason and
  // costs nothing — its own `rows` ref changing already implies a new `widgetRows`.
  //
  // An absent source is still recorded (as all-null) so a later data load invalidates.
  const trackedReadSourceIds = new Set(readSourceIds);
  trackedReadSourceIds.add(widgetSourceId);
  trackedReadSourceIds.add(anchorSourceId);

  // `setLruEntry` evicts the least-recently-used entries before inserting when at capacity.
  setLruEntry(byKey, configKey, {
    relationships,
    exprFields: relevantExprFields,
    readSourceDeps: captureSourceDeps(trackedReadSourceIds, dataSources),
    result,
  });
  return result;
}
