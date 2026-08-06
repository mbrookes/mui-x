/**
 * Generic value caps — the primitives every boundary in this package bounds strings, numbers and
 * nested values with.
 *
 * These are not request-shaped or tool-shaped: `capTitle` caps a title wherever one arrives,
 * `capFilterValue` caps a filter value whether it came in on the request body or out of a model's
 * tool arguments. They lived in `executeToolOnState.ts` for the accidental reason that the first
 * cap written there needed them, which is how a file named for tool execution came to hold the
 * larger half of the request trust boundary.
 *
 * A leaf module: it imports only types, so both `requestCaps.ts` (which caps the inbound
 * dashboard state) and `executeToolOnState.ts` (which caps model-supplied tool arguments) can
 * depend on it without either depending on the other.
 */

/**
 * Max length of a model-supplied stored title (dashboard / page / widget). These
 * strings are re-interpolated into `<dashboard_state>` on EVERY future request, so an
 * unbounded title is a persistent token bomb — `sanitizeForPrompt`
 * neutralizes markup but not size. Capped at the write source so the oversized string
 * never lands in state. Larger than `rename_thread`'s 40-char cap because dashboard and
 * widget titles are legitimately longer than a chat-thread label, but still bounded.
 */
export const MAX_TITLE_LENGTH = 200;

/**
 * Max length of a model-supplied filter `field`/`sourceId` string (and of a
 * string-typed filter `value`), persisted verbatim by `add_page_filter` /
 * `add_widget_filter`. Same rationale — and same token-bomb class — as
 * {@link MAX_TITLE_LENGTH}: `buildAISystemPrompt.ts` re-interpolates every active
 * filter's `field`/`value` (via `JSON.stringify(f.value)`) into the "Active
 * Filters" block on EVERY subsequent request, so an unbounded value persists as
 * a token bomb across the whole conversation.
 *
 * Exported so `mcp/queryTools.ts` can cap `query_data_source`'s
 * `filters[].field`/`get_field_values.fieldId` strings with the SAME bound already
 * applied to the conceptually identical `add_page_filter`/`add_widget_filter`
 * `field` string, rather than inventing a second constant for the same class of
 * short identifier string.
 */
export const MAX_FILTER_STRING_LENGTH = 200;

/**
 * Max number of entries kept in an array-typed filter `value` (e.g. an `in`
 * operator's value list). An unbounded array is JSON-stringified into the
 * system prompt on every future request exactly like an oversized string.
 */
export const MAX_FILTER_VALUE_ARRAY_LENGTH = 50;

/**
 * Max number of keys retained in a plain-object-typed filter `value`. `capFilterValue`'s array
 * branch already bounds array length and its string branch bounds string length, but the object
 * branch previously recursed over EVERY key with no cap on key COUNT — so a model-supplied
 * object-typed filter `value` with a huge number of (individually short) keys was persisted
 * verbatim and re-interpolated via `JSON.stringify(f.value)` into `<dashboard_state>` on every
 * subsequent request, exactly the same persistent token-bomb class the array-length cap already
 * guards against. Reuses {@link MAX_FILTER_VALUE_ARRAY_LENGTH}'s 50-entry convention rather than
 * inventing a second bound for the same class of unbounded container.
 */
export const MAX_FILTER_VALUE_OBJECT_KEYS = MAX_FILTER_VALUE_ARRAY_LENGTH;

/**
 * Max length of an object KEY retained inside a model-supplied filter `value` or
 * widget `config`.
 *
 * Every cap in this file bounded object VALUES and entry COUNTS; key NAMES at any
 * depth were never bounded at all. Both containers are re-serialized in full on
 * every subsequent request — `buildAISystemPrompt.ts` echoes a filter value via
 * `JSON.stringify(f.value)`, and `describeWidget` echoes config content — and a
 * key is just as much of that serialization as its value. The concrete reachable
 * case: `customConfig` is a SHARED config key, valid on every widget kind and
 * arbitrarily shaped by design, so
 * `add_widget({ kind:'chart', title:'t', config:{ customConfig:{ "<1,000,000 chars>": 1 } } })`
 * passes every existing gate and lands a 1 MB key in persisted `doc.widgets` and
 * in every future `get_dashboard_state` payload.
 *
 * Reuses {@link MAX_FILTER_STRING_LENGTH} — a key is the same class of short
 * identifier string as a filter `field` or a `sourceId`, both already bounded by
 * it. Truncation can in principle collide two keys sharing a 200-char prefix
 * (last write wins); that is the same trade-off the entry-COUNT caps already make
 * by dropping entries outright, and no legitimate config or filter key comes close
 * to the bound.
 */
export const MAX_OBJECT_KEY_LENGTH = MAX_FILTER_STRING_LENGTH;

/**
 * Max number of TOP-LEVEL keys retained in a model-supplied widget `config`.
 * `capConfigStringValues` bounded the shape of every VALUE but never
 * the number of keys at the top level, even though its own nested branches
 * (`capShallowConfigValue`) have bounded key count since they were written. An
 * unbounded key count is both a persisted token bomb and an unbounded RESPONSE
 * echo: `invalidConfigKeyError` joins every offending key into its error string.
 * Sized at 200 — matching `capIncomingCustomWidgets`'s
 * `MAX_CUSTOM_WIDGET_CONFIG_KEYS` for the same kind of config bag — because a
 * legitimate chart config can legally carry well over a hundred keys (the union of
 * the shared keys and a chart family's own), so the 50-entry nested bound would be
 * too tight here.
 */
export const MAX_CONFIG_KEYS = 200;

/**
 * Max number of layout rows accepted by `set_widget_layout` / `apply_bulk_update`'s
 * `layout` op. Same unbounded-work/token-bomb class as
 * {@link MAX_BULK_UPDATE_OPS}: an unbounded row array is re-flattened and re-validated
 * on every call and, once committed, re-described on every future request.
 */
export const MAX_LAYOUT_ROWS = 200;

/**
 * Max distinct values per field emitted in a `get_dashboard_state` payload. The
 * full `fieldDistinctValues` list can be arbitrarily large (every unique value of
 * a high-cardinality column), so it is capped here — both to avoid a token bomb
 * and to avoid dumping a full column's contents into the model context.
 */
export const MAX_DISTINCT_VALUES_IN_STATE_OUTPUT = 20;

/** Cap a model-supplied string to `maxLength` characters. */
export function capString(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/** Cap a model-supplied title to {@link MAX_TITLE_LENGTH} (see the constant's rationale). */
export function capTitle(title: string): string {
  return capString(title, MAX_TITLE_LENGTH);
}

/**
 * Max recursion depth `capFilterValue`/`capShallowConfigValue` will descend into a
 * nested array/object value. Bounds the work done on a pathologically deep
 * model-supplied structure.
 */
export const MAX_FILTER_VALUE_DEPTH = 5;

/**
 * What a container found AT the recursion depth limit is replaced with.
 *
 * The depth guards previously returned the remaining subtree VERBATIM, which made
 * the depth limit a complete cap BYPASS rather than a work bound: a 1 MB string or
 * a 100,000-entry array nested one level past the limit skipped the 200-char /
 * 50-entry caps entirely and was persisted and re-interpolated on every subsequent
 * request — the exact token-bomb class these caps exist to close, reachable by
 * simply adding nesting. (`mcp/queryTools.ts` relies on `capFilterValue` for the
 * same bound on the forwarded-query path.)
 *
 * Replacing the over-deep container with a marker rather than recursing further
 * keeps the work bound intact AND closes the bypass, and follows this package's
 * "say so, don't silently truncate" convention (`SYSTEM_PROMPT_TRUNCATION_NOTE`,
 * `truncateSkipped`'s "…N more", `projectDataSourceMetadata`'s `truncated` flag) —
 * the model reads why the value stops rather than reasoning over a subtree it
 * cannot know was dropped. Scalars at the limit (number/boolean/null, and strings,
 * which are length-capped before the depth check) pass through unchanged: they are
 * inherently bounded, so there is nothing to bypass.
 */
export const DEPTH_LIMIT_MARKER = '[truncated: nested too deeply]';

/**
 * Cap a model-supplied filter `value` before persisting it — same token-bomb class
 * `capTitle` guards against. String values are truncated to
 * {@link MAX_FILTER_STRING_LENGTH}; array values (e.g. an `in` list) are truncated
 * to {@link MAX_FILTER_VALUE_ARRAY_LENGTH} entries. Recurses into array elements and plain-object
 * properties so a huge string or object NESTED inside an array-typed value is also capped, not just
 * the array's own length — `buildAISystemPrompt.ts` echoes the whole value via
 * `JSON.stringify(f.value)` on every future request, so an uncapped element anywhere inside the
 * structure is just as much a persistent token bomb as an uncapped top-level string. Object KEY
 * names are length-capped as well as counted ({@link MAX_OBJECT_KEY_LENGTH}), and a container found
 * AT the depth limit is replaced with
 * {@link DEPTH_LIMIT_MARKER} rather than returned verbatim — returning
 * it made the depth limit a complete cap bypass. Other JSON-serializable scalar
 * shapes (number/boolean/null) are left as-is.
 *
 * Exported so `mcp/queryTools.ts` can apply the
 * SAME cap to `query_data_source`'s `filters[].value` — that path forwards
 * model-supplied filters straight to the host's `queryDataSource` callback rather
 * than persisting them onto dashboard state, but a megabyte-sized string/array
 * `value` is exactly the same unbounded-work/token-bomb class this function
 * already guards `add_page_filter`/`add_widget_filter` against.
 */
export function capFilterValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return capString(value, MAX_FILTER_STRING_LENGTH);
  }
  if (depth >= MAX_FILTER_VALUE_DEPTH) {
    // A container here is REPLACED, not returned verbatim; see
    // {@link DEPTH_LIMIT_MARKER} for why returning it was a cap bypass.
    return value !== null && typeof value === 'object' ? DEPTH_LIMIT_MARKER : value;
  }
  if (Array.isArray(value)) {
    const bounded =
      value.length > MAX_FILTER_VALUE_ARRAY_LENGTH
        ? value.slice(0, MAX_FILTER_VALUE_ARRAY_LENGTH)
        : value;
    return bounded.map((entry) => capFilterValue(entry, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    // `Object.create(null)`, not `{}`: the keys are model-supplied, so a
    // `{"__proto__": {…}}` filter value silently LOST that entry on a normal object
    // literal (assigning an object to `__proto__` rewrites the prototype instead of
    // creating a property) while the tool still reported `{ success: true }`. Same
    // treatment the sibling `capFieldDistinctValues`/`capDataSources` maps already get.
    const capped: Record<string, unknown> = Object.create(null);
    // Bound the NUMBER of retained keys, not just each key's
    // recursively-capped value — an object with thousands of short keys is otherwise
    // persisted and re-interpolated verbatim, the same token-bomb class the array
    // branch above already caps by length.
    const entries = Object.entries(value as Record<string, unknown>);
    const boundedEntries =
      entries.length > MAX_FILTER_VALUE_OBJECT_KEYS
        ? entries.slice(0, MAX_FILTER_VALUE_OBJECT_KEYS)
        : entries;
    for (const [key, entry] of boundedEntries) {
      // The KEY is length-capped too, not just the value; see
      // {@link MAX_OBJECT_KEY_LENGTH}.
      capped[capString(key, MAX_OBJECT_KEY_LENGTH)] = capFilterValue(entry, depth + 1);
    }
    return capped;
  }
  return value;
}

/**
 * Cap a model-supplied `sourceId` string before persisting it onto a widget — same
 * token-bomb class as {@link MAX_TITLE_LENGTH}/{@link MAX_FILTER_STRING_LENGTH}:
 * `buildAISystemPrompt.ts`'s `describeWidget` echoes a widget's resolved source into
 * `<dashboard_state>` on every future request. Reuses `MAX_FILTER_STRING_LENGTH` —
 * the same bound already applied to a filter's `field`/`sourceId` — rather than
 * inventing a new constant for what is the same class of short identifier string.
 */
export function capSourceId(sourceId: string): string {
  return capString(sourceId, MAX_FILTER_STRING_LENGTH);
}

/**
 * Max number of entries retained in an array-typed widget config field (e.g.
 * `ySeries`, `annotations`, `funnelCategoryOrder`, `funnelStageSequence`, grid
 * `columns`) before it is persisted (sibling to {@link capConfigStringValues}'s
 * string cap — Tier 1 architecture-review finding). Reuses
 * `MAX_FILTER_VALUE_ARRAY_LENGTH`'s 50-entry convention rather than inventing a
 * new bound for the same class of unbounded array.
 */
export const MAX_CONFIG_ARRAY_LENGTH = MAX_FILTER_VALUE_ARRAY_LENGTH;

/**
 * Max recursion depth {@link capShallowConfigValue} will descend into a nested
 * widget-config value (Tier 1 architecture-review finding). Mirrors
 * `capFilterValue`'s {@link MAX_FILTER_VALUE_DEPTH} pattern: config values were
 * previously capped only ONE level deep, which missed two real nested config
 * shapes — `StudioSharedWidgetConfig.customConfig` (arbitrary consumer JSON,
 * valid on every widget kind) and `StudioGridConfig.gridConditionalFormats[].style`
 * (whose `backgroundColor`/`color` strings sit one level past what the old
 * one-level cap inspected). Both are echoed into `<dashboard_state>` verbatim by
 * `buildAISystemPrompt.ts` on every future request, so an uncapped string
 * nested past the first level is exactly the same persistent token-bomb class
 * `capTitle`/`capFilterValue` already guard against. Values beyond this depth
 * are left as-is (bounded work, not infinite recursion on a pathologically deep
 * structure), same trade-off `capFilterValue` makes.
 */
export const MAX_CONFIG_VALUE_DEPTH = 4;

/**
 * Caps a single config value, recursing up to {@link MAX_CONFIG_VALUE_DEPTH}
 * levels deep (Tier 1 architecture-review finding — see
 * {@link MAX_CONFIG_VALUE_DEPTH} for why one level was not enough): a string
 * (e.g. a `funnelCategoryOrder`/`funnelStageSequence` array entry) is
 * length-capped directly; an array (e.g. a nested array inside `customConfig`)
 * has its length bounded to {@link MAX_CONFIG_ARRAY_LENGTH} and each element
 * recursively capped; a plain object (e.g. a `ySeries`/`annotations`/grid
 * `columns` array entry, a nested single-object config value like `forecast`,
 * or an arbitrarily-shaped `customConfig`/`gridConditionalFormats[].style`) has
 * its key COUNT bounded to `MAX_FILTER_VALUE_OBJECT_KEYS` and every value
 * recursively capped. Any other shape (number, boolean, `null`) is left as-is.
 * Shared by {@link capConfigStringValues} for both array ELEMENTS and direct
 * nested-object config VALUES.
 */
export function capShallowConfigValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return capString(value, MAX_FILTER_STRING_LENGTH);
  }
  if (depth >= MAX_CONFIG_VALUE_DEPTH) {
    // Same bypass as `capFilterValue`'s guard — a container at the depth
    // limit is replaced, never returned verbatim (see {@link DEPTH_LIMIT_MARKER}).
    return value !== null && typeof value === 'object' ? DEPTH_LIMIT_MARKER : value;
  }
  if (Array.isArray(value)) {
    const bounded =
      value.length > MAX_CONFIG_ARRAY_LENGTH ? value.slice(0, MAX_CONFIG_ARRAY_LENGTH) : value;
    return bounded.map((entry) => capShallowConfigValue(entry, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    // Null-prototype for the same reason as `capFilterValue`'s object branch — `customConfig` is
    // arbitrarily shaped model JSON, so `__proto__` is a reachable key here.
    const capped: Record<string, unknown> = Object.create(null);
    const entries = Object.entries(value as Record<string, unknown>);
    const boundedEntries =
      entries.length > MAX_FILTER_VALUE_OBJECT_KEYS
        ? entries.slice(0, MAX_FILTER_VALUE_OBJECT_KEYS)
        : entries;
    for (const [key, prop] of boundedEntries) {
      // The KEY is length-capped too (`customConfig` is an arbitrarily
      // shaped consumer bag, so its keys are as model-supplied as its values).
      capped[capString(key, MAX_OBJECT_KEY_LENGTH)] = capShallowConfigValue(prop, depth + 1);
    }
    return capped;
  }
  return value;
}

/**
 * Cap every STRING-typed value in a model-supplied widget `config` object before persisting it, AND
 * every ARRAY-typed value's length plus its elements' string content, AND every nested-OBJECT-typed
 * value's string properties RECURSIVELY up to {@link MAX_CONFIG_VALUE_DEPTH} levels deep (Tier 1
 * architecture-review finding — the recursion closes a real gap: a plain one-level cap missed
 * `customConfig`'s arbitrarily-nested consumer JSON and
 * `gridConditionalFormats[].style.backgroundColor`/`color`, both of which sit past the first
 * level). Chart-config string fields such as `xField`/`yField`/`seriesField` (and their
 * per-chart-type siblings — `ganttLabelField`, `sankeyTargetField`, `scatterColorField`,
 * `heatYField`, …) are free-form model-supplied field-id strings with no existing length bound, and
 * `buildAISystemPrompt.ts`'s `describeWidget` echoes every one of them into `<dashboard_state>` on
 * EVERY future request — the same persistent token-bomb class `capTitle`/`capFilterValue` already
 * guard against. Array-typed config fields (`ySeries`, `annotations`, `funnelCategoryOrder`,
 * `funnelStageSequence`, grid `columns`, …) and single nested-object fields (`forecast`, whose
 * `method` is echoed via `describeWidget`'s `enabled (${method}, ${periods} periods)`) are exactly
 * the same class of hazard: `describeWidget` echoes their FULL content (not just a count) into the
 * same prompt block on every turn, so an unbounded array/object — or one containing
 * unboundedly-long strings — is just as much a persistent token bomb as an oversized scalar string.
 * Reuses `MAX_FILTER_STRING_LENGTH` (the bound already applied to filter `field`/`sourceId`) and
 * `MAX_CONFIG_ARRAY_LENGTH` rather than inventing new constants. Other non-string/array/object
 * values (numbers, booleans) are left untouched — they are either already value-checked elsewhere
 * (`invalidConfigValueError`) or out of scope for this cap. Accepts `unknown` (not just a record)
 * so it can be applied directly to an untrusted `args.config` (or a custom widget's
 * `defaultConfig`) at the write source; any non-plain-object input (including `null`/arrays) is
 * returned unchanged for the caller's own shape validation to reject.
 *
 * Two further bounds cover the config's KEY space, which no cap in this file
 * covered before: the TOP-LEVEL key count ({@link MAX_CONFIG_KEYS} — the nested
 * branches had a key-count bound from the start, the top level did not) and every
 * key's LENGTH at any depth ({@link MAX_OBJECT_KEY_LENGTH}). `customConfig` is a
 * `SHARED_CONFIG_KEYS` member valid on every widget kind and arbitrarily shaped by
 * design, so a 1 MB KEY inside it passed every gate and landed in persisted
 * `doc.widgets` and every future `get_dashboard_state`.
 */
export function capConfigStringValues(config: unknown): unknown {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return config;
  }
  // Null-prototype for the same reason as the two helpers above.
  const capped: Record<string, unknown> = Object.create(null);
  // Bound the TOP-LEVEL key COUNT and each key's LENGTH, not just the
  // values. The nested branches (`capShallowConfigValue`) already bounded key count;
  // the top level did not, and no branch bounded key names at all. See
  // {@link MAX_CONFIG_KEYS} / {@link MAX_OBJECT_KEY_LENGTH}.
  for (const [rawKey, value] of Object.entries(config as Record<string, unknown>).slice(
    0,
    MAX_CONFIG_KEYS,
  )) {
    const key = capString(rawKey, MAX_OBJECT_KEY_LENGTH);
    if (typeof value === 'string') {
      capped[key] = capString(value, MAX_FILTER_STRING_LENGTH);
    } else if (Array.isArray(value)) {
      // NOT `.map(capShallowConfigValue)`: `Array.prototype.map` invokes its callback
      // with `(element, index, array)`, and `capShallowConfigValue`'s SECOND parameter
      // is now the recursion `depth` (Tier 1 architecture-review finding) — passing the
      // callback directly would silently feed the array INDEX in as `depth`, corrupting
      // the depth budget for every element past index 0. Wrap it so each element always
      // starts its own recursion fresh at `depth = 0`.
      capped[key] = value
        .slice(0, MAX_CONFIG_ARRAY_LENGTH)
        .map((entry) => capShallowConfigValue(entry));
    } else if (value !== null && typeof value === 'object') {
      capped[key] = capShallowConfigValue(value);
    } else {
      capped[key] = value;
    }
  }
  return capped;
}

/**
 * Max length of a model-supplied entity `.id` (widget/page/data-source) retained
 * from an incoming, client-supplied `dashboardState` (Tier 1 architecture-review
 * finding). Unlike a `title`/`label`, an entity's `.id` is a SEPARATE field from
 * its map key — `buildAISystemPrompt.ts` echoes it verbatim regardless
 * (`pushField('id', widget.id)`, `sanitizeForPrompt(page.id)`,
 * `sanitizeForPrompt(source.id)`) on EVERY future request, and
 * `sanitizeForPrompt` only escapes `<`/`>` — it never bounds length. So an
 * oversized `.id` is the same persistent token-bomb class `capTitle` already
 * guards the title fields against. Reuses `MAX_FILTER_STRING_LENGTH` (the
 * identifier-string bound already applied to `sourceId`/filter `field`) rather
 * than inventing a new constant for the same class of short id string.
 */
export const MAX_ENTITY_ID_LENGTH = MAX_FILTER_STRING_LENGTH;

/** Cap a model-supplied entity id to {@link MAX_ENTITY_ID_LENGTH}. */
export function capEntityId(id: string): string {
  return capString(id, MAX_ENTITY_ID_LENGTH);
}
