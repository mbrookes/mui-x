/**
 * The request trust boundary: capping the client-supplied body before any of it reaches the
 * system prompt, the context enricher, or the agentic loop.
 *
 * One job, one chokepoint — `handleAIChat` calls these in five consecutive statements — but for a
 * long time two files. `capIncomingDashboardState` and its thirty `MAX_STATE_*` constants lived
 * in `executeToolOnState.ts` because that is where the entity `cap*` helpers already were, while
 * `capIncomingRichContext` and its siblings lived in `handleAIChat.ts` because that is where
 * their fields were read. Nothing about the split followed the job; it followed which request
 * field a given hardening round happened to be closing. `handleAIChat.ts` even stated the goal it
 * was missing — "one place to look for what bounds request input" — next to the calls.
 *
 * The reason all of this is capped at all: the server is not the trusted party here. Every value
 * below is interpolated into `<dashboard_state>`/`<dashboard_context>` on the FIRST request and
 * on every request after it, and the per-tool `cap*` helpers only run when a tool MUTATES state —
 * so without a request-time pass, a dashboard's titles, filter values, field distinct values and
 * layout reach the model completely unbounded.
 *
 * Depends only on `valueCaps.ts` and types, so it sits below every consumer.
 */
import type { SerializableSkill, StudioAIRichContext } from '../models/aiTypes';
import type {
  StudioCustomWidgetDef,
  StudioState,
  StudioWidget,
  StudioPage,
  StudioFilterState,
  StudioDataField,
  StudioDataSource,
} from '../models/studioTypes';
import { asString, capText, capMaybeText } from './promptCaps';
import { isPlainRecord } from './guards';
import {
  capString,
  capTitle,
  capEntityId,
  capSourceId,
  capFilterValue,
  capConfigStringValues,
  MAX_TITLE_LENGTH,
  MAX_FILTER_STRING_LENGTH,
  MAX_LAYOUT_ROWS,
} from './valueCaps';

/**
 * Max number of pages / widgets / filters retained from an INCOMING, client-supplied
 * `dashboardState` before it is interpolated into `<dashboard_state>`.
 *
 * Every `cap*` helper above only runs when an AI tool MUTATES state — the very first
 * request's `dashboardState` comes straight from the client `body` and is fed into the
 * system prompt with only `sanitizeForPrompt` (which neutralizes `<`/`>` but neither
 * truncates length nor counts). So a client could post thousands of pages/widgets/
 * filters (each with an oversized title / megabyte filter value) and blow the system
 * prompt up unbounded on turn one — before any tool-call cap can apply, and before
 * `maxTokensPerRequest` (checked only AFTER a turn completes, and a documented no-op
 * when a gateway omits usage chunks) could ever catch it. {@link capIncomingDashboardState}
 * closes that gap by running the incoming state through the same caps at the top of
 * request handling. These count bounds are sized generously — far beyond any realistic
 * hand-authored dashboard — so they only ever trip for a runaway/hostile payload; kept
 * as three separate constants because pages, widgets, and filters legitimately scale
 * very differently.
 */
export const MAX_STATE_PAGES = 200;

export const MAX_STATE_WIDGETS = 1000;

export const MAX_STATE_FILTERS = 500;

/**
 * Max number of `runtime.dataSources` entries retained from an incoming,
 * client-supplied `dashboardState` before it is interpolated into
 * `<dashboard_state>`'s "## Data Sources" section (Tier 1 resource-exhaustion
 * finding, sibling to {@link MAX_STATE_PAGES}/{@link MAX_STATE_WIDGETS}/
 * {@link MAX_STATE_FILTERS}). `buildAISystemPrompt.ts`'s `buildDashboardState`
 * does `Object.values(dataSources)` with NO existing count cap, and
 * `describeSource`/`serializeFieldForAI` interpolate every entry's free-text
 * strings with only `sanitizeForPrompt`'s angle-bracket escaping — escaping
 * neutralizes markup but does not bound size. A client posting thousands of
 * fabricated data sources would blow the very first system prompt up
 * unbounded, before any tool-call cap or token-budget check could apply.
 * Sized like {@link MAX_STATE_FILTERS} — a real integration wires at most a
 * few dozen data sources, so this only ever trips a runaway/hostile payload.
 */
export const MAX_STATE_DATA_SOURCES = 500;

/**
 * Max number of `fields` entries retained per data source in the same cap pass
 * (see {@link MAX_STATE_DATA_SOURCES}). `describeSource` iterates every field
 * with no existing cap, and each field is individually rendered via
 * `serializeFieldForAI` in `<dashboard_state>`.
 */
export const MAX_STATE_DATA_SOURCE_FIELDS = 500;

/**
 * Max number of rows retained in an incoming, client-supplied `page.widgetRows`
 * layout matrix (Tier 1 architecture-review finding). Mirrors
 * {@link MAX_LAYOUT_ROWS} — the bound already applied to the model-authored
 * `set_widget_layout` write path — for the INCOMING request-body read path:
 * `buildAISystemPrompt.ts`'s "## Layout" block iterates the active page's
 * `widgetRows` with no cap of its own on the very first request.
 */
export const MAX_STATE_LAYOUT_ROWS = MAX_LAYOUT_ROWS;

/**
 * Max number of widget-id cells retained per incoming `page.widgetRows` row (see
 * {@link MAX_STATE_LAYOUT_ROWS}). A single pathological row (e.g. one widget id
 * repeated a million times) is just as unbounded as too many rows.
 */
export const MAX_STATE_LAYOUT_ROW_CELLS = 50;

/**
 * Max number of entries retained in an incoming `page.widgetColSpans` map (see
 * {@link MAX_STATE_LAYOUT_ROWS}). A well-formed `widgetColSpans` map never
 * legitimately carries more entries than there are widgets, so it is bounded to
 * the same count as {@link MAX_STATE_WIDGETS}.
 */
export const MAX_STATE_WIDGET_COL_SPANS = MAX_STATE_WIDGETS;

/**
 * Max number of `capabilities` entries retained per incoming data-source field.
 * `serializeFieldForAI` renders `f.capabilities.join('+')` into
 * every field's tag list with no cap of its own, so an unbounded array is the same
 * first-request token bomb as an unbounded `label`. A real field declares one or
 * two capabilities.
 */
export const MAX_STATE_FIELD_CAPABILITIES = 20;

/**
 * Max number of `fieldDistinctValues` map entries retained per incoming data
 * source. Bounded to the same count as the source's own field list,
 * since a well-formed map never carries more entries than there are fields.
 */
export const MAX_STATE_FIELD_DISTINCT_VALUE_KEYS = MAX_STATE_DATA_SOURCE_FIELDS;

/**
 * Max length of a single `fieldDistinctValues` value retained.
 * `serializeFieldForAI` renders every value IN FULL when a field has ≤8 of them,
 * so one 50 MB value passed straight into the first system prompt —
 * `MAX_DISTINCT_VALUES_IN_STATE_OUTPUT` already existed for the
 * `get_dashboard_state` output path but was never applied to this read path.
 * Reuses {@link MAX_FILTER_STRING_LENGTH}: a distinct value is the same class of
 * short data string as a filter value, which is already bounded by it.
 */
export const MAX_STATE_DISTINCT_VALUE_LENGTH = MAX_FILTER_STRING_LENGTH;

/**
 * Max number of distinct values retained per field on the incoming READ path.
 *
 *
 * Deliberately NOT `MAX_DISTINCT_VALUES_IN_STATE_OUTPUT` (20), which bounds the
 * `get_dashboard_state` OUTPUT path: `serializeFieldForAI` renders the values in
 * full at ≤8, renders a bare `"N values"` count at ≤30, and omits them entirely
 * above 30. Truncating to 20 here would rewrite a 10,000-value high-cardinality
 * field into a plausible-looking `"20 values"` cardinality hint and mislead the
 * model's chart/filter-type choices. 50 sits above every rendering threshold, so
 * each field renders EXACTLY as it did before while the retained array is bounded.
 */
export const MAX_STATE_DISTINCT_VALUES_PER_FIELD = 50;

/**
 * Every id-bearing key across the `StudioFilterScope` union. Listed by
 * NAME rather than switched on `scope.kind` because `scope` is unvalidated client
 * JSON: a `kind` that doesn't match any variant must still get its ids capped.
 */
export const FILTER_SCOPE_ID_KEYS = ['pageId', 'widgetId', 'sourceWidgetId', 'sourceId'] as const;

/**
 * Cap the identifiers inside a filter's `scope`.
 *
 * `scope.widgetId` lands in the `## Active Filters` prompt line's `widget:<id>`
 * label, and the whole `scope` is echoed by `get_dashboard_state` — but
 * `capIncomingDashboardState`'s `...f` spread carried it through untouched while
 * every sibling identifier got {@link capEntityId}. Reusing the same bound also keeps
 * a scope id comparable to the page/widget ids it is matched against, which are
 * capped with `capEntityId` in the loops above.
 *
 * Returns a spreadable patch: `{}` when there is no object-shaped scope to rewrite,
 * so a missing or malformed `scope` keeps whatever the `...f` spread already put
 * there (the prompt builder's `f?.scope?.kind` guard handles it from there).
 */
export function capFilterScope(scope: unknown): { scope?: StudioFilterState['scope'] } {
  if (scope === null || typeof scope !== 'object') {
    return {};
  }
  const capped: Record<string, unknown> = { ...(scope as Record<string, unknown>) };
  for (const key of FILTER_SCOPE_ID_KEYS) {
    if (capped[key] !== undefined) {
      capped[key] = capEntityId(asString(capped[key]));
    }
  }
  return { scope: capped as StudioFilterState['scope'] };
}

/**
 * Cap a model-supplied `StudioDataField`'s free-text strings before it is
 * persisted onto an incoming data source (see {@link MAX_STATE_DATA_SOURCES}).
 * `label`/`aiDescription` reuse {@link MAX_TITLE_LENGTH} — the same bound
 * already applied to dashboard/page/widget titles — rather than inventing a
 * new constant for the same class of free-text string. `format` is nominally
 * typed as a fixed `StudioNumberFormat` enum, but `dashboardState` is
 * client-supplied JSON with no runtime enum check, so it is capped the same
 * defensive way (`serializeFieldForAI` interpolates it verbatim).
 */
export function capDataSourceField(field: StudioDataField): StudioDataField {
  // `dashboardState` is unvalidated client JSON, so a `fields: [null]`
  // entry reached `field.label` here and threw a raw, unprefixed `TypeError`.
  // `validateStudioAIRequestBody` now rejects that shape up front; this stays as
  // defense-in-depth for the other (non-`handleAIChat`) callers of this cap pass.
  const f = (field ?? {}) as StudioDataField;
  return {
    ...f,
    // `id` is echoed into EVERY field rendering
    // (`serializeFieldForAI`'s `sanitizeForPrompt(f.id)`) on every request, exactly
    // like the source/page/widget ids `capEntityId` already bounds; only
    // `label`/`format`/`aiDescription` were capped before.
    id: capEntityId(asString(f.id ?? '')),
    label: capTitle(asString(f.label ?? '')),
    ...(f.format !== undefined
      ? { format: capString(asString(f.format), MAX_TITLE_LENGTH) as StudioDataField['format'] }
      : {}),
    // Rendered as `capabilities.join('+')`, unbounded in both entry
    // count and per-entry length.
    ...(Array.isArray(f.capabilities)
      ? {
          capabilities: f.capabilities
            .slice(0, MAX_STATE_FIELD_CAPABILITIES)
            .map((c) =>
              capString(asString(c ?? ''), MAX_FILTER_STRING_LENGTH),
            ) as StudioDataField['capabilities'],
        }
      : {}),
    // Rendered as `default:<value>` in the field's tag list.
    ...(f.defaultAggregationFn !== undefined
      ? {
          defaultAggregationFn: capString(
            asString(f.defaultAggregationFn),
            MAX_FILTER_STRING_LENGTH,
          ) as StudioDataField['defaultAggregationFn'],
        }
      : {}),
    ...(f.aiDescription !== undefined
      ? { aiDescription: capTitle(asString(f.aiDescription)) }
      : {}),
  };
}

/**
 * Cap an incoming `source.fieldDistinctValues` map.
 *
 * `serializeFieldForAI` renders every value IN FULL when a field has ≤8 of them,
 * so a single oversized value landed verbatim in the first system prompt.
 * `capDataSource` never touched this map before, even though
 * `MAX_DISTINCT_VALUES_IN_STATE_OUTPUT` already existed for the
 * `get_dashboard_state` OUTPUT path — this applies the same bound to the incoming
 * READ path, plus a per-value length cap and a map-key count/length cap.
 */
export function capFieldDistinctValues(
  fieldDistinctValues: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (fieldDistinctValues === undefined || fieldDistinctValues === null) {
    return undefined;
  }
  // `Object.create(null)`: the keys are client-supplied field ids, and
  // a `__proto__`/`constructor` key must address an ordinary own slot rather than
  // being silently dropped or routed into the prototype.
  const capped: Record<string, string[]> = Object.create(null);
  for (const [fieldId, values] of Object.entries(fieldDistinctValues).slice(
    0,
    MAX_STATE_FIELD_DISTINCT_VALUE_KEYS,
  )) {
    // A malformed (non-array) entry is DROPPED rather than coerced to `[]`: an empty
    // array would render as a `0: ` cardinality hint, inventing a fact about the
    // field. Dropping it renders exactly as "no distinct values known" (the
    // sibling — the read site also `Array.isArray`-guards this).
    if (Array.isArray(values)) {
      capped[capEntityId(asString(fieldId))] = values
        .slice(0, MAX_STATE_DISTINCT_VALUES_PER_FIELD)
        .map((v) => capString(asString(v ?? ''), MAX_STATE_DISTINCT_VALUE_LENGTH));
    }
  }
  return capped;
}

/**
 * Cap a model-supplied `StudioDataSource` before it is interpolated into
 * `<dashboard_state>`'s "## Data Sources" section (see
 * {@link MAX_STATE_DATA_SOURCES}). Caps the `fields` count
 * ({@link MAX_STATE_DATA_SOURCE_FIELDS}) and every field's free-text strings
 * (via {@link capDataSourceField}), plus the source's own `label`/
 * `aiDescription`/`id` ({@link MAX_ENTITY_ID_LENGTH} — see its doc comment for
 * why the `id`, a field separate from the map key, must be length-capped too).
 *
 * `tableName` is normalized rather than capped, because it is the one field here
 * that leaves the process: it is forwarded to the host's `queryDataSource` (and,
 * for a Knex host, straight into `db(tableName)`) instead of merely being rendered
 * into the prompt. The `...source` spread used to pass it through untouched, so a
 * request body asserting `tableName: { orders: 'secrets' }` reached the host as an
 * object — which Knex reads as an alias map, querying a table the caller chose.
 * A non-string or over-long value is therefore DROPPED, not coerced or truncated:
 * coercing `{…}` would invent a table name (`String({…})` yields
 * `"[object Object]"`; the {@link asString} that replaced it yields `""`) and a
 * truncated name would address a DIFFERENT table, whereas dropping it leaves the
 * source without a `tableName`, which every resolver already reports as an unknown
 * / unqueryable data source.
 */
export function capDataSource(source: StudioDataSource): StudioDataSource {
  const cappedDistinct = capFieldDistinctValues(source.fieldDistinctValues);
  const usableTableName =
    typeof source.tableName === 'string' &&
    source.tableName.length > 0 &&
    source.tableName.length <= MAX_FILTER_STRING_LENGTH;
  return {
    ...source,
    id: capEntityId(asString(source.id ?? '')),
    label: capTitle(asString(source.label ?? '')),
    ...(source.tableName !== undefined && !usableTableName ? { tableName: undefined } : {}),
    ...(source.aiDescription !== undefined
      ? { aiDescription: capTitle(asString(source.aiDescription)) }
      : {}),
    fields: (Array.isArray(source.fields) ? source.fields : [])
      .slice(0, MAX_STATE_DATA_SOURCE_FIELDS)
      .map(capDataSourceField),
    // This map was never capped, even though every value in it is
    // rendered verbatim into the first system prompt for a ≤8-value field.
    ...(cappedDistinct !== undefined ? { fieldDistinctValues: cappedDistinct } : {}),
  };
}

/**
 * Cap a client-supplied `page.widgetRows` layout matrix and `widgetColSpans` map
 * before it is interpolated into `<dashboard_state>`'s "## Layout" block (Tier 1
 * architecture-review finding, sibling to `capDataSources`). Bounds the ROW
 * count and the CELL count per row ({@link MAX_STATE_LAYOUT_ROWS}/
 * {@link MAX_STATE_LAYOUT_ROW_CELLS} — mirroring `set_widget_layout`'s own
 * {@link MAX_LAYOUT_ROWS} write-path cap, which this incoming-state read path had
 * no equivalent of), each retained cell id's length
 * ({@link MAX_ENTITY_ID_LENGTH}), and the `widgetColSpans` entry count
 * ({@link MAX_STATE_WIDGET_COL_SPANS}). Truncates rather than rejects — this
 * runs on the READ path (the very first request's `dashboardState`), which has
 * no caller to report a validation error back to.
 */
export function capPageWidgetRows(
  widgetRows: string[][] | undefined,
): { widgetRows: string[][] } | Record<string, never> {
  // `widgetRows` is unvalidated client JSON — a `"abc"` (string) or
  // `["abc"]` (array of strings) value previously reached `.slice(…).map(…)` on a
  // non-array row and threw a raw `TypeError: row.slice is not a function`.
  // `validateStudioAIRequestBody` now rejects those shapes up front; this stays as
  // defense-in-depth for the other callers, normalising a malformed row to empty
  // rather than throwing.
  if (!Array.isArray(widgetRows)) {
    return {};
  }
  return {
    widgetRows: widgetRows
      .slice(0, MAX_STATE_LAYOUT_ROWS)
      .map((row) =>
        (Array.isArray(row) ? row : [])
          .slice(0, MAX_STATE_LAYOUT_ROW_CELLS)
          .map((id) => capEntityId(asString(id ?? ''))),
      ),
  };
}

/**
 * Cap a client-supplied `runtime.dataSources` map (Tier 1 resource-exhaustion
 * finding — see {@link MAX_STATE_DATA_SOURCES}) before `capIncomingDashboardState`
 * threads it forward. Bounds entry count, per-source field count, and every
 * free-text string, mirroring the `doc`-partition caps below.
 */
export function capDataSources(
  dataSources: Record<string, StudioDataSource>,
): Record<string, StudioDataSource> {
  // `Object.create(null)`, not `{}`: these keys come straight from the
  // client body, and a source keyed `__proto__` would otherwise be silently dropped
  // from the prompt (an assignment to `{}`'s `__proto__` with an object value
  // rewrites the prototype instead of creating an entry). A null-prototype map has
  // no such member, so every key round-trips as an ordinary own property. Every
  // downstream read of this map already goes through an `Object.hasOwn` guard.
  const capped: Record<string, StudioDataSource> = Object.create(null);
  for (const [id, source] of Object.entries(dataSources).slice(0, MAX_STATE_DATA_SOURCES)) {
    // The map KEY is echoed into the prompt independently of the
    // entry's own `.id` field (`Object.entries` in `projectStateForAI`, and the
    // key is what every `sourceId` reference resolves against), so it needs the
    // same length bound `.id` already gets.
    capped[capEntityId(asString(id))] = capDataSource(source);
  }
  return capped;
}

/**
 * Cap a client-supplied `dashboardState` by running its
 * dashboard title, pages, widgets, and filters through the SAME caps the AI-tool
 * mutation paths already apply at their write sources — `capTitle` for dashboard/
 * page/widget titles, `capEntityId` for each widget/page/data-source `id`,
 * `capSourceId` for widget `sourceId`, `capConfigStringValues` for each widget
 * `config`, `capPageWidgetRows` for each page's `widgetRows`/`widgetColSpans`
 * layout, `capFilterValue` for each filter `value`/`value2`, and
 * `MAX_FILTER_STRING_LENGTH` for filter `field`/`filterSourceId` — plus a count cap
 * on each of pages/widgets/filters ({@link MAX_STATE_PAGES}/{@link MAX_STATE_WIDGETS}/
 * {@link MAX_STATE_FILTERS}).
 *
 * Also caps `runtime.dataSources` (Tier 1 resource-exhaustion finding —
 * see {@link MAX_STATE_DATA_SOURCES}/{@link capDataSources}): unlike the other
 * `doc` partitions this cap guards, `dataSources` is interpolated into the
 * system prompt directly from `runtime`, with no per-tool-call write path of
 * its own to cap at — so this is the ONLY chokepoint that bounds it.
 *
 * Applied once, at the top of `handleAIChat` request handling, BEFORE the state is
 * used to build the system prompt or threaded into the agentic loop as the starting
 * `currentState`. Returns a shallow-cloned state; the input is not mutated.
 *
 * WHAT THIS DOES **NOT** COVER (corrected — the previous wording called these
 * "non-interpolated … passed through unchanged", which was false for the first
 * half): the `doc` sub-partitions `relationships`, `expressionFields`,
 * `filterPresets` and `ai` are passed through UNCAPPED, and they are NOT
 * uninterpolated — `projectStateForAI` spreads the whole `doc` (minus `ai`), so all
 * three of `relationships`/`expressionFields`/`filterPresets` are emitted verbatim
 * by the `get_dashboard_state` tool and the `studio://dashboard/state` resource.
 * They are absent only from the `<dashboard_state>` SYSTEM PROMPT block, which is
 * what the original claim actually described. The bounds that do apply to them are
 * downstream, not here: `capToolOutput` bounds the chat tool-result size, and
 * `projectStateForAI` length-caps the `ai` thread `id`/`name` it emits (that path
 * has no write-source cap of its own). Adding count/shape caps for the three
 * structured sub-partitions is deliberately NOT done here — each is a typed graph
 * the reducer and the pipeline consume by shape, so truncating one would silently
 * break relationship resolution or expression evaluation rather than merely
 * shortening a string; bounding them belongs at the same `validateStudioAIRequestBody`
 * shape boundary that already types the rest of the body.
 */
export function capIncomingDashboardState(state: StudioState): StudioState {
  const { doc } = state;

  const cappedDashboard = {
    ...doc.dashboard,
    title: capTitle(asString(doc.dashboard.title ?? '')),
    // `activePageId` was the one `doc.dashboard` field that is neither
    // type-validated by `validateStudioAIRequestBody` nor capped here, yet it is
    // echoed verbatim into `list_pages` and `get_dashboard_state` output and read as
    // a page-map key by nearly every tool. Same `capEntityId` bound the page ids it
    // is compared against already get, so the two can't disagree about length.
    activePageId: capEntityId(asString(doc.dashboard.activePageId ?? '')),
  };

  // `Object.create(null)` for both maps and a capped map KEY for every
  // entry — see `capDataSources` above for both rationales. The key is
  // a SEPARATE string from the entry's own `.id`: `buildAISystemPrompt.ts` echoes the
  // key wherever a layout row or `focusedWidgetId` names it, so capping only `.id`
  // left the key unbounded.
  const cappedWidgets: Record<string, StudioWidget> = Object.create(null);
  for (const [id, widget] of Object.entries(doc.widgets).slice(0, MAX_STATE_WIDGETS)) {
    cappedWidgets[capEntityId(asString(id))] = {
      ...widget,
      // `widget?.` throughout: a `doc.widgets: { w1: null }` body
      // previously threw a raw `TypeError: Cannot read properties of null (reading
      // 'id')` right here. The validator now rejects that shape; these guards keep
      // the other callers of this cap pass crash-free too.
      id: capEntityId(asString(widget?.id ?? '')),
      title: capTitle(asString(widget?.title ?? '')),
      // `kind` is interpolated into `<dashboard_state>` on every future
      // request (`describeWidget`'s `pushField('kind', widget.kind)`) and echoed by
      // `get_dashboard_state`, but it is a bare `...widget` spread away from every
      // sibling identifier that already gets `capEntityId`. Nothing bounded it except
      // the aggregate `MAX_SYSTEM_PROMPT_CHARS` backstop. Conditional so a genuinely
      // absent `kind` stays absent rather than becoming `''`.
      ...(widget?.kind !== undefined
        ? { kind: capEntityId(asString(widget.kind)) as StudioWidget['kind'] }
        : {}),
      ...(widget?.subtitle !== undefined
        ? { subtitle: capString(asString(widget.subtitle), MAX_TITLE_LENGTH) }
        : {}),
      ...(widget?.sourceId !== undefined
        ? { sourceId: capSourceId(asString(widget.sourceId)) }
        : {}),
      // Default a missing `config` to `{}`. Every widget-describing
      // branch in `buildAISystemPrompt.ts` dereferences it (`resolveChartType(cfg)`,
      // `kpiCfg.kpiValueField`, …), so a config-less widget on the active page threw
      // an opaque `TypeError: Cannot read properties of undefined (reading
      // 'chartType')` and killed every chat request for that dashboard.
      config: capConfigStringValues(widget?.config ?? {}) as StudioWidget['config'],
    } as StudioWidget;
  }

  const cappedPages: Record<string, StudioPage> = Object.create(null);
  for (const [id, page] of Object.entries(doc.pages).slice(0, MAX_STATE_PAGES)) {
    // `page?.` throughout: a `doc.pages: { p1: null }` body previously
    // threw a raw `TypeError: Cannot read properties of null (reading
    // 'widgetColSpans')` right here.
    const cappedColSpans =
      page?.widgetColSpans && typeof page.widgetColSpans === 'object'
        ? Object.fromEntries(
            Object.entries(page.widgetColSpans)
              .slice(0, MAX_STATE_WIDGET_COL_SPANS)
              .map(([spanId, span]) => [capEntityId(asString(spanId)), span]),
          )
        : undefined;
    cappedPages[capEntityId(asString(id))] = {
      ...page,
      id: capEntityId(asString(page?.id ?? '')),
      title: capTitle(asString(page?.title ?? '')),
      ...capPageWidgetRows(page?.widgetRows),
      ...(cappedColSpans !== undefined ? { widgetColSpans: cappedColSpans } : {}),
    };
  }

  // `f?.` throughout: a `doc.filters: [null]` body previously threw a
  // raw `TypeError: Cannot read properties of null (reading 'field')` here.
  const cappedFilters: StudioFilterState[] = doc.filters.slice(0, MAX_STATE_FILTERS).map((f) => ({
    ...f,
    // `id` and `operator` are both interpolated bare into the
    // `## Active Filters` prompt line (`[id: …] scope:… — field operator value`) and
    // echoed by `get_dashboard_state`, yet the `...f` spread was the only thing that
    // put them there. Every sibling identifier already gets `capEntityId`; these now
    // do too, so the line is bounded field by field rather than only by the aggregate
    // `MAX_SYSTEM_PROMPT_CHARS` backstop.
    ...(f?.id !== undefined ? { id: capEntityId(asString(f.id)) } : {}),
    ...(f?.operator !== undefined
      ? { operator: capEntityId(asString(f.operator)) as StudioFilterState['operator'] }
      : {}),
    // `scope.widgetId` is interpolated into the same line's
    // `widget:<id>` label. Capping with `capEntityId` keeps it comparable to the
    // widget/page ids above, which are capped with the same bound.
    ...capFilterScope(f?.scope),
    field: capString(asString(f?.field ?? ''), MAX_FILTER_STRING_LENGTH),
    ...(f?.filterSourceId !== undefined
      ? { filterSourceId: capString(asString(f.filterSourceId), MAX_FILTER_STRING_LENGTH) }
      : {}),
    value: capFilterValue(f?.value),
    ...(f?.value2 !== undefined ? { value2: capFilterValue(f.value2) } : {}),
  }));

  return {
    ...state,
    doc: {
      ...doc,
      dashboard: cappedDashboard,
      pages: cappedPages,
      widgets: cappedWidgets,
      filters: cappedFilters,
    },
    // `session.mode` is interpolated into the prompt's `Mode: …` line but
    // this cap never rewrote `session` at all, so it was the one prompt-interpolated
    // state string with no per-field bound of any kind.
    ...(state.session !== undefined && state.session !== null
      ? {
          session: {
            ...state.session,
            ...(state.session.mode !== undefined
              ? {
                  mode: capEntityId(asString(state.session.mode)) as StudioState['session']['mode'],
                }
              : {}),
          },
        }
      : {}),
    runtime: {
      ...state.runtime,
      dataSources: capDataSources(state.runtime.dataSources),
    },
  };
}

// ── The other half: the non-`dashboardState` request fields ──────────────────

/**
 * Max string length a capped `richContext`/`customWidgets` free-text field is
 * truncated to (Tier 1 resource-exhaustion finding, sibling to
 * `executeToolOnState.ts`'s `MAX_TITLE_LENGTH`). Both `richContext` and
 * `customWidgets` are client-supplied request fields interpolated into the
 * FIRST system prompt (via `buildAISystemPrompt.ts`'s `buildRichContextBlock`
 * and its custom-widget listing loop) with only `sanitizeForPrompt`'s
 * angle-bracket escaping — no length bound of its own. Sized the same as
 * `MAX_TITLE_LENGTH` rather than inventing a second constant for the same
 * class of free-text string.
 */
export const MAX_REQUEST_STRING_LENGTH = 200;

/**
 * Max number of `richContext.fieldStats` keys retained (Tier 1
 * resource-exhaustion finding). `buildRichContextBlock` iterates
 * `Object.entries(rc.fieldStats)` with no existing cap before interpolating
 * every entry into `<dashboard_context>`. `StudioAIRichContext`'s own doc
 * comment says the CLIENT is expected to stay under a token budget — that is
 * a documented assumption, not a server-enforced bound, so a hostile/buggy
 * client is not actually stopped by it.
 */
export const MAX_RICH_CONTEXT_FIELD_STATS = 500;

/** Max number of `richContext.pageLayout.rows` retained (see {@link MAX_RICH_CONTEXT_FIELD_STATS}). */
export const MAX_RICH_CONTEXT_LAYOUT_ROWS = 200;

/** Max number of widget cells retained per `richContext.pageLayout.rows` row (see {@link MAX_RICH_CONTEXT_FIELD_STATS}). */
export const MAX_RICH_CONTEXT_ROW_CELLS = 50;

/** Max number of `richContext.pageLayout.crossFilters` entries retained (see {@link MAX_RICH_CONTEXT_FIELD_STATS}). */
export const MAX_RICH_CONTEXT_CROSS_FILTERS = 200;

/** Max number of `richContext.recentMutations` entries retained (see {@link MAX_RICH_CONTEXT_FIELD_STATS}). */
export const MAX_RICH_CONTEXT_RECENT_MUTATIONS = 200;

/** Max number of `richContext.omitted` entries retained (see {@link MAX_RICH_CONTEXT_FIELD_STATS}). */
export const MAX_RICH_CONTEXT_OMITTED = 50;

/**
 * Max number of `customWidgets` entries retained from the request body
 * (Tier 1 resource-exhaustion finding). `buildAISystemPrompt.ts` loops over
 * the whole array, unbounded, to list each custom widget kind in the system
 * prompt.
 */
export const MAX_REQUEST_CUSTOM_WIDGETS = 200;

/**
 * Max number of `defaultConfig` keys retained per `customWidgets` entry (see
 * {@link MAX_REQUEST_CUSTOM_WIDGETS}). `buildAISystemPrompt.ts` interpolates
 * `Object.keys(cw.defaultConfig)` in full with no existing cap.
 */
export const MAX_CUSTOM_WIDGET_CONFIG_KEYS = 200;

/**
 * Max number of `body.skills` entries retained. Nothing capped
 * `skills` AT ALL before: `validateStudioAIRequestBody` only checked that each
 * entry's `name` is a string, and every retained entry's `promptFragment` (and, for
 * `server-tool` mode, its tool `description`/`parameters`) is interpolated into the
 * system prompt — which is then re-sent on EVERY one of up to 10 turns.
 */
export const MAX_REQUEST_SKILLS = 100;

/**
 * Max length of a skill's `promptFragment`. This is deliberately far
 * larger than {@link MAX_REQUEST_STRING_LENGTH} — a fragment is real instruction
 * prose, not a label — but it must still be bounded: a single
 * `promptFragment: 'A'.repeat(50e6)` produced a 50 MB system prompt, re-sent every
 * turn, before any token budget (checked only AFTER a turn completes) could apply.
 */
export const MAX_SKILL_PROMPT_FRAGMENT_CHARS = 20_000;

/** Max length of a `server-tool` skill's tool `description` (see {@link MAX_SKILL_PROMPT_FRAGMENT_CHARS}). */
export const MAX_SKILL_TOOL_DESCRIPTION_CHARS = 4_000;

/**
 * Max serialized size of a `server-tool` skill's JSON-Schema `parameters` object.
 * Sent verbatim in the `tools` array of every LLM request. A schema
 * over this size is rejected — replaced with an empty object schema — rather than
 * truncated, since a half-truncated JSON Schema is not a valid schema.
 */
export const MAX_SKILL_TOOL_PARAMETERS_CHARS = 20_000;

/**
 * Max length of `body.pageSnapshot`. Validated as a string but never
 * length-capped: its mere presence advertises `summarise_page`, whose output is the
 * snapshot VERBATIM — which is then appended to `currentMessages` and re-sent on
 * every remaining turn. Sized to a generous page-summary CSV (~25K tokens).
 */
export const MAX_PAGE_SNAPSHOT_CHARS = 100_000;

/** Cap a value to {@link MAX_REQUEST_STRING_LENGTH} when it is a string; pass through otherwise. */
export function capRequestString(value: unknown): unknown {
  return capMaybeText(value, MAX_REQUEST_STRING_LENGTH);
}

/**
 * Cap every present string-typed field of a `richContext.fieldStats` entry
 * (Tier 1 architecture-review finding, sibling to the array/count caps below).
 * `min`/`max`/`mean`/`distinctCount`/`sampledRows`/`type` are nominally typed
 * `number`/enum, but `richContext` is client-supplied JSON with no runtime type
 * check, so a crafted body can smuggle an oversized string into any of them —
 * `buildRichContextBlock` interpolates every one via `sanitizeForPrompt(String(v))`
 * with no length bound of its own. Only fields actually present on the entry are
 * touched, so an entry missing e.g. `min` does not gain a spurious `min: undefined`
 * key. Non-string values (the well-formed common case) pass through
 * `capRequestString` unchanged.
 */
export function capFieldStatEntry(stat: Record<string, unknown>): Record<string, unknown> {
  const capped: Record<string, unknown> = { ...stat };
  for (const key of ['type', 'min', 'max', 'mean', 'distinctCount', 'sampledRows'] as const) {
    if (Object.hasOwn(stat, key)) {
      capped[key] = capRequestString(stat[key]);
    }
  }
  return capped;
}

/**
 * Cap every present string-typed field of a `richContext.pageLayout.rows` cell
 * (a `StudioAILayoutWidget`) — see {@link capFieldStatEntry} for the same
 * rationale. `widgetId`/`kind`/`title`/`chartType` are echoed verbatim into
 * `<dashboard_context>`, and `colSpan` (nominally `number`) is echoed the same
 * way (`buildAISystemPrompt.ts` already notes it can carry a smuggled string).
 */
export function capLayoutWidgetCell(cell: Record<string, unknown>): Record<string, unknown> {
  const capped: Record<string, unknown> = { ...cell };
  for (const key of ['widgetId', 'kind', 'title', 'chartType', 'colSpan'] as const) {
    if (Object.hasOwn(cell, key)) {
      capped[key] = capRequestString(cell[key]);
    }
  }
  return capped;
}

/**
 * Cap every present string-typed field of a `richContext.pageLayout.crossFilters`
 * entry (a `StudioAICrossFilterEdge`) — see {@link capFieldStatEntry}.
 * `sourceWidgetId`/`field`/`scope` are all echoed verbatim into
 * `<dashboard_context>`'s cross-filter graph listing.
 */
export function capCrossFilterEdge(edge: Record<string, unknown>): Record<string, unknown> {
  const capped: Record<string, unknown> = { ...edge };
  for (const key of ['sourceWidgetId', 'field', 'scope'] as const) {
    if (Object.hasOwn(edge, key)) {
      capped[key] = capRequestString(edge[key]);
    }
  }
  return capped;
}

/**
 * Cap a client-supplied `richContext` (Tier 1 resource-exhaustion finding,
 * sibling to `executeToolOnState.ts`'s `capIncomingDashboardState`) before it
 * is threaded into `buildAISystemPrompt`'s `<dashboard_context>` block.
 * `buildRichContextBlock` already defensively guards against malformed shapes
 * (a non-plain-object `fieldStats`, a non-array `pageLayout.rows`, …) via
 * `isPlainObject`/`Array.isArray` checks and simply omits a malformed
 * section — so this cap mirrors those SAME shape guards and only bounds the
 * count/length of an otherwise-well-shaped section, leaving a malformed one
 * untouched for `buildRichContextBlock` to skip as it already does.
 *
 * Caps element/entry COUNTS as before, and additionally caps the LENGTH of
 * every individual string field inside each retained element (Tier 1
 * architecture-review finding): `fieldStats` entry values (via
 * {@link capFieldStatEntry}), `pageLayout.pageId`, each `pageLayout.rows` cell
 * (via {@link capLayoutWidgetCell}), and each `pageLayout.crossFilters` entry
 * (via {@link capCrossFilterEdge}) — the same class of gap the sibling
 * `recentMutations.label` cap already closed for its own section.
 *
 * Applied once, at the same request-handling chokepoint as
 * `capIncomingDashboardState`, before `richContext` reaches the context
 * enricher or the agentic loop. Returns the input unchanged when it is not a
 * plain object (including `undefined`); never mutates the input.
 */
export function capIncomingRichContext(
  richContext: StudioAIRichContext | undefined,
): StudioAIRichContext | undefined {
  if (!isPlainRecord(richContext)) {
    return richContext;
  }
  const rc = richContext as unknown as {
    fieldStats?: unknown;
    pageLayout?: unknown;
    recentMutations?: unknown;
    omitted?: unknown;
  };
  const capped: Record<string, unknown> = { ...richContext };

  if (isPlainRecord(rc.fieldStats)) {
    capped.fieldStats = Object.fromEntries(
      Object.entries(rc.fieldStats)
        .slice(0, MAX_RICH_CONTEXT_FIELD_STATS)
        // Finding: the entry KEY (the field name itself) was never
        // length-capped — only the entry COUNT and each entry's VALUES were.
        // `buildRichContextBlock` echoes the raw key verbatim with no length bound
        // of its own, so an oversized key is the same token-bomb class every
        // capped value here already guards against. `capRequestString` only
        // touches strings (a no-op guard, since `Object.entries` keys are always
        // strings) so the cast is safe.
        .map(([key, stat]) => [
          capRequestString(key) as string,
          isPlainRecord(stat) ? capFieldStatEntry(stat) : stat,
        ]),
    );
  }

  if (isPlainRecord(rc.pageLayout)) {
    const layout = rc.pageLayout as { pageId?: unknown; rows?: unknown; crossFilters?: unknown };
    const cappedLayout: Record<string, unknown> = { ...layout };
    if (Object.hasOwn(layout, 'pageId')) {
      cappedLayout.pageId = capRequestString(layout.pageId);
    }
    if (Array.isArray(layout.rows)) {
      cappedLayout.rows = layout.rows
        .slice(0, MAX_RICH_CONTEXT_LAYOUT_ROWS)
        .map((row) =>
          Array.isArray(row)
            ? row
                .slice(0, MAX_RICH_CONTEXT_ROW_CELLS)
                .map((cell) => (isPlainRecord(cell) ? capLayoutWidgetCell(cell) : cell))
            : row,
        );
    }
    if (Array.isArray(layout.crossFilters)) {
      cappedLayout.crossFilters = layout.crossFilters
        .slice(0, MAX_RICH_CONTEXT_CROSS_FILTERS)
        .map((edge) => (isPlainRecord(edge) ? capCrossFilterEdge(edge) : edge));
    }
    capped.pageLayout = cappedLayout;
  }

  if (Array.isArray(rc.recentMutations)) {
    capped.recentMutations = rc.recentMutations
      .slice(0, MAX_RICH_CONTEXT_RECENT_MUTATIONS)
      .map((m) => (isPlainRecord(m) ? { ...m, label: capRequestString(m.label) } : m));
  }

  if (Array.isArray(rc.omitted)) {
    capped.omitted = rc.omitted.slice(0, MAX_RICH_CONTEXT_OMITTED).map(capRequestString);
  }

  return capped as StudioAIRichContext;
}

/**
 * Cap a client-supplied `customWidgets` array (Tier 1 resource-exhaustion
 * finding, sibling to {@link capIncomingRichContext}) before it is threaded
 * into `buildAISystemPrompt`'s custom-widget listing loop and the agentic
 * loop's widget-creation tools. Caps the array length
 * ({@link MAX_REQUEST_CUSTOM_WIDGETS}) and, per entry, the `kind`/`label`/
 * `description` string length ({@link MAX_REQUEST_STRING_LENGTH}) and the
 * `defaultConfig` key count ({@link MAX_CUSTOM_WIDGET_CONFIG_KEYS}).
 * `kind` is capped for the SAME reason `label`/`description` are: it is echoed
 * straight into the first system prompt (both in the custom-widget listing and
 * — for a widget actually created with that kind — into every subsequent
 * `<dashboard_state>` via `describeWidget`'s `pushField('kind', widget.kind)`),
 * so an unbounded `kind` is exactly the same persistent token-bomb class as an
 * unbounded `label` (Tier 1 architecture-review finding). `defaultConfig`'s
 * key/value VALIDATION (not just its key-count cap here) happens later, at the
 * point a widget of that kind is actually built — see
 * `executeToolOnState.ts`'s `buildWidgetFromArgs`. `validateStudioAIRequestBody`
 * has already guaranteed each element is a plain object with a string `kind` by
 * the time this runs. Returns the input unchanged when it is `undefined`; never
 * mutates the input.
 */
export function capIncomingCustomWidgets(
  customWidgets: StudioCustomWidgetDef[] | undefined,
): StudioCustomWidgetDef[] | undefined {
  if (!customWidgets) {
    return customWidgets;
  }
  return customWidgets.slice(0, MAX_REQUEST_CUSTOM_WIDGETS).map((cw) => ({
    ...cw,
    kind: capRequestString(cw.kind) as string,
    label: capRequestString(cw.label) as string,
    ...(cw.description !== undefined
      ? { description: capRequestString(cw.description) as string }
      : {}),
    ...(isPlainRecord(cw.defaultConfig)
      ? {
          defaultConfig: Object.fromEntries(
            Object.entries(cw.defaultConfig)
              .slice(0, MAX_CUSTOM_WIDGET_CONFIG_KEYS)
              // Only the key COUNT was capped, never the key STRING —
              // and `buildAISystemPrompt.ts` echoes `Object.keys(cw.defaultConfig)`
              // verbatim into the custom-widget listing. The identical gap was
              // already closed for `richContext.fieldStats` keys above; this sibling
              // was missed. `capRequestString` only touches strings (a no-op guard,
              // since `Object.entries` keys are always strings), so the cast is safe.
              .map(([key, value]) => [capRequestString(key) as string, value]),
          ),
        }
      : {}),
  }));
}

/**
 * Cap a client-supplied `skills` array before its content reaches the
 * system prompt (`buildAISystemPrompt.ts`'s `buildSkillSection`) and the advertised
 * `tools` array (`agenticLoop.ts`'s `skillToolDefs`).
 *
 * `skills` had NO cap of any kind — not entry count, not `promptFragment` length,
 * not tool `description`/`parameters` size — while being interpolated into the
 * HIGHER-TRUST system region and re-sent on every one of up to 10 turns. A single
 * `skills: [{ name: 'x', mode: 'instruction-only', promptFragment: 'A'.repeat(50e6) }]`
 * produced a 50 MB system prompt per turn, and the per-turn token budget cannot
 * help: it is checked only AFTER a turn completes (and is a documented no-op when a
 * gateway omits usage chunks).
 *
 * Note this is a SIZE cap only. It is not, and cannot be, a trust boundary — the
 * server-side lever for untrusted skill CONTENT is `options.allowedSkills`, which
 * substitutes host-authored definitions by name.
 *
 * Entries are DEDUPED BY `name` before the count cap. `allowedSkills`
 * resolution maps every body entry naming the same allowlisted skill onto the SAME
 * host-registered definition, so a body asserting one allowlisted name N times
 * resolves to N copies of one skill — N identical `promptFragment`s concatenated by
 * `buildSkillSection` and N `tools` entries sharing a `function.name` on every turn.
 * Deduping first collapses that to one entry while leaving distinct skills intact;
 * the count cap then bounds what remains. Order is preserved: the first entry for a
 * given name wins.
 *
 * This function is the ONE place the skill list is bounded, and it is applied to the
 * RESOLVED list (after `allowedSkills` substitution) rather than to `body.skills`, so
 * neither resolution branch can skip it.
 *
 * `validateStudioAIRequestBody` has already guaranteed each element is an object
 * with a string `name` by the time this runs. Returns the input unchanged when it is
 * `undefined`; never mutates the input.
 */
export function capIncomingSkills(
  skills: SerializableSkill[] | undefined,
): SerializableSkill[] | undefined {
  if (!skills) {
    return skills;
  }
  const seenNames = new Set<string>();
  const deduped: SerializableSkill[] = [];
  for (const skill of skills) {
    if (!seenNames.has(skill.name)) {
      seenNames.add(skill.name);
      deduped.push(skill);
    }
    if (deduped.length >= MAX_REQUEST_SKILLS) {
      break;
    }
  }
  return deduped.map((skill) => {
    const tool: unknown = (skill as { tool?: unknown }).tool;
    let cappedTool: SerializableSkill['tool'];
    if (isPlainRecord(tool)) {
      let parameters = tool.parameters;
      // A JSON Schema cannot be truncated and stay a schema, so an oversized one is
      // REPLACED with a permissive empty object schema. The tool stays callable; the
      // model just loses the (hostile-sized) argument hints.
      let serializedLength: number;
      try {
        serializedLength = JSON.stringify(parameters ?? null).length;
      } catch {
        // Cyclic/unserializable — treat as over budget; it could not be sent anyway.
        serializedLength = Number.POSITIVE_INFINITY;
      }
      if (serializedLength > MAX_SKILL_TOOL_PARAMETERS_CHARS) {
        parameters = { type: 'object', properties: {} };
      }
      cappedTool = {
        ...tool,
        name: capText(tool.name, MAX_REQUEST_STRING_LENGTH),
        description: capText(tool.description, MAX_SKILL_TOOL_DESCRIPTION_CHARS),
        parameters: (parameters ?? {}) as object,
      };
    }
    return {
      ...skill,
      name: capText(skill.name, MAX_REQUEST_STRING_LENGTH),
      mode: capText(skill.mode, MAX_REQUEST_STRING_LENGTH) as SerializableSkill['mode'],
      promptFragment: capText(skill.promptFragment, MAX_SKILL_PROMPT_FRAGMENT_CHARS),
      // Assigned UNCONDITIONALLY, not through a
      // `...(cappedTool !== undefined ? { tool } : {})` spread. The conditional spread
      // read as "leave `tool` alone when there was nothing to cap", but this object is
      // built on top of `...skill` — so when `isPlainRecord(tool)` FAILED (`tool` was a
      // string, an array, a number, …) the spread added nothing and the RAW, unusable
      // value survived from the base spread. It then passed `agenticLoop.ts`'s
      // `s.tool` truthiness filter and produced `function: {}` on the wire. Writing
      // `undefined` here overwrites it, so a `tool` this function refuses to cap is a
      // `tool` no downstream reader can see. `validateStudioAIRequestBody` rejects that
      // shape outright before this runs; this keeps the cap sound on its own for any
      // caller that reaches it another way.
      tool: cappedTool,
    };
  });
}

/**
 * Cap a client-supplied `pageSnapshot` to
 * {@link MAX_PAGE_SNAPSHOT_CHARS}.
 *
 * Applied at the same request-handling chokepoint as the other caps, BEFORE the
 * value reaches the agentic loop — where its presence advertises `summarise_page`
 * and its content becomes that tool's output verbatim, appended to the conversation
 * and re-sent on every remaining turn.
 */
export function capIncomingPageSnapshot(pageSnapshot: string | undefined): string | undefined {
  return typeof pageSnapshot === 'string'
    ? capText(pageSnapshot, MAX_PAGE_SNAPSHOT_CHARS)
    : pageSnapshot;
}
