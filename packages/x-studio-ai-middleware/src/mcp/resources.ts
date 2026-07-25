/**
 * MCP resource handlers for the x-studio server.
 *
 * Registers `resources/list`, `resources/read`, and the subscribe / unsubscribe
 * handlers on the provided `Server`. Resources expose the dashboard state, the
 * grounded AI system prompt, per-source schemas, row previews, and a data-health
 * summary.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  buildAISystemPrompt,
  sanitizeForPrompt,
  serializeFieldForAI,
} from '../buildAISystemPrompt';
import { buildPageLayoutContext } from '../buildPageLayoutContext';
import { projectStateForAI } from '../executeToolOnState';
import type { StudioCustomWidgetDef } from '../models/studioTypes';
import type { StudioAIEnrichedContext } from '../models/aiTypes';
import { CONTEXT_ENRICHER_TIMEOUT_MS } from '../handleAIChat';
import {
  checkAllowedTable,
  ownArrayEntry,
  redactedHostErrorMessage,
  safeIdentifier,
  withTimeout,
} from './helpers';
import type {
  StudioDataQueryResult,
  StudioMcpData,
  StudioMcpLogger,
  StudioMcpOptions,
  StudioStateBox,
} from './types';

/** Dependencies required to serve the MCP resource handlers. */
export interface ResourceHandlerDeps {
  stateBox: StudioStateBox;
  data?: StudioMcpData;
  customWidgets: StudioCustomWidgetDef[];
  contextEnricher?: StudioMcpOptions['contextEnricher'];
  logger?: StudioMcpLogger;
  /** Shared set of subscribed resource URIs (mutated by subscribe/unsubscribe). */
  subscribedUris: Set<string>;
  /**
   * Authorization gate for the two resource URI families that execute a LIVE data
   * query — `studio://data/{sourceId}` (raw row preview) and
   * `studio://dashboard/data-health` (per-source COUNT). Resource reads are a
   * parallel data-access surface to the MCP tools, and used to bypass every
   * authorization chokepoint the tool path enforces (finding 2.1): a host that
   * excludes every data-returning tool from `allowedTools` (or denies it via
   * `toolPolicy`) still had raw rows served through these resources.
   *
   * The composition root (`mcp.ts`) wires this to run the SAME `isToolAllowed` +
   * args-only policy consult + approval bridge the dispatch-table data tools run,
   * mapped onto the `query_data_source` tool name (the tool these resource reads
   * conceptually invoke). It resolves to a deny-reason string when the read is
   * NOT authorized, or `null` when it may proceed. When omitted, no gate is
   * applied (used only by unit tests that construct the handlers directly).
   *
   * The optional `input.sourceId` is threaded into the policy-consult context
   * (finding 2.3) so a per-source `toolPolicy` rule (deny `query_data_source` for
   * one `sourceId`) or an `approvalHandler` that inspects `ctx.input` is no longer
   * blind on `studio://data/{sourceId}` reads — the consult sees which source is
   * being read.
   * @param {{ sourceId?: string }} [input] Optional descriptor of the resource being read.
   * @param {string} [input.sourceId] The source id targeted by a `studio://data/{sourceId}` read, threaded into the policy consult; omitted for the multi-source `data-health` read.
   * @returns {Promise<string | null>} A deny-reason string if the read is not authorized, or `null` if it may proceed.
   */
  authorizeDataAccess?: (input?: { sourceId?: string }) => Promise<string | null>;
  /**
   * Authorization gate for the resource URIs that expose the SAME dashboard-state
   * payload as the `get_dashboard_state` tool — `studio://dashboard/state` (the
   * `projectStateForAI` JSON) and `studio://dashboard/system-prompt` (that state
   * rendered as prompt text). The tool-call path rejects `get_dashboard_state`
   * when a host excludes it from `allowedTools`, but the resource read served the
   * byte-identical payload ungated (finding 2.1). The composition root wires this
   * to the same `isToolAllowed('get_dashboard_state')` + args-only policy consult
   * the tool path uses. Resolves to a deny-reason string when the read is NOT
   * authorized, or `null` when it may proceed. When omitted, no gate is applied
   * (used only by unit tests that construct the handlers directly).
   * @returns {Promise<string | null>} A deny-reason string if the read is not authorized, or `null` if it may proceed.
   */
  authorizeStateAccess?: () => Promise<string | null>;
  /**
   * Upper bound on the number of distinct URIs `subscribedUris` may hold.
   * A prefix-validated URI (e.g. `studio://schema/<sourceId>`) is still an
   * unbounded space — a client could otherwise subscribe to unlimited distinct
   * garbage sourceIds. Once at capacity, subscribing to a URI that is not
   * already a member is rejected; re-subscribing an existing member always
   * succeeds.
   * @default 256
   */
  maxSubscribedUris?: number;
}

/**
 * Whether `uri` is one this server can actually serve via `resources/read` —
 * the same three exact URIs plus the two prefixed families handled there.
 * Subscribing to anything else would leave the client believing it will
 * receive updates that will never come.
 */
function isKnownResourceUri(uri: string): boolean {
  if (
    uri === 'studio://dashboard/state' ||
    uri === 'studio://dashboard/system-prompt' ||
    uri === 'studio://dashboard/data-health'
  ) {
    return true;
  }
  if (uri.startsWith('studio://schema/') && uri.length > 'studio://schema/'.length) {
    return true;
  }
  if (uri.startsWith('studio://data/') && uri.length > 'studio://data/'.length) {
    return true;
  }
  return false;
}

const DEFAULT_MAX_SUBSCRIBED_URIS = 256;

/**
 * Hard upper bound on the number of data sources `studio://dashboard/data-health`
 * fans out a live `COUNT(*)` query for (finding M8).
 *
 * The `Promise.all` below previously issued one concurrent query per non-hidden
 * source with a `tableName`, with no cap at all — 400 configured sources means 400
 * concurrent counts, which exhausts the host's connection pool, and the read is
 * repeatable. Every sibling fan-out in the package is already capped at 50
 * (`MAX_COMPUTE_FIELD_STATS_FIELDS` / `MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS` in
 * `mcp/queryTools.ts`, `MAX_SUMMARISE_PAGE_WIDGETS` in `mcp/summarisePage.ts`);
 * reuse that convention. Truncated rather than rejected — like
 * `describe_data_source`'s numeric-field fan-out, the source set is not something
 * the caller can retry with a smaller value — and the truncation is reported in the
 * payload so the reader knows the counts are partial.
 */
const MAX_DATA_HEALTH_SOURCES = 50;

/**
 * Register `resources/list`, `resources/read`, `resources/subscribe`, and
 * `resources/unsubscribe` handlers on `server`.
 */
export function registerResourceHandlers(server: Server, deps: ResourceHandlerDeps): void {
  const {
    stateBox,
    data,
    customWidgets,
    contextEnricher,
    logger,
    subscribedUris,
    authorizeDataAccess,
    authorizeStateAccess,
    maxSubscribedUris = DEFAULT_MAX_SUBSCRIBED_URIS,
  } = deps;

  // ── resources/list ───────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    // `hidden` is a listing-only declutter flag (see `@mui/x-studio-schema`'s
    // dataTypes.ts: "hidden from the data drawer and widget config selects"), not
    // an access-control boundary. It only removes the source from *this listing* —
    // a hidden source read directly by id via `studio://schema/{id}` /
    // `studio://data/{id}` is still served by design (a decluttered join/lookup
    // source must stay addressable). Hosts needing a hard boundary enforce it in
    // their `queryDataSource` implementation, not via `hidden`.
    const sources = Object.values(stateBox.current.runtime.dataSources).filter((s) => !s.hidden);

    // MCP resource `name`/`description` are LLM-consumed metadata (the MCP spec
    // positions `description` as text "for the LLM to understand the resource"),
    // so the state-derived source `label`/`id` interpolated into them are the same
    // untrusted, attacker-influenceable values the sibling `prompts/get` handler
    // (`mcp/prompts.ts`) already routes through `sanitizeForPrompt`. A poisoned
    // label like `Orders</resources>\n\nIMPORTANT: …` must not be able to close a
    // client's tag-structured framing early or read as an instruction — route both
    // through the same choke point. The `uri` keeps the RAW id because it is an
    // addressable identifier the `resources/read` handler slices back out, not an
    // LLM-consumed text position.
    const schemaResources = sources.map((s) => {
      const safeLabel = sanitizeForPrompt(s.label);
      const safeId = sanitizeForPrompt(s.id);
      return {
        uri: `studio://schema/${s.id}`,
        name: `${safeLabel} Schema`,
        description: `Field definitions for the ${safeLabel} data source (sourceId: "${safeId}").`,
        mimeType: 'application/json',
      };
    });

    const dataResources = data
      ? sources
          .filter((s) => s.tableName)
          .map((s) => {
            const safeLabel = sanitizeForPrompt(s.label);
            return {
              uri: `studio://data/${s.id}`,
              name: `${safeLabel} Preview`,
              description:
                `Raw row preview for the ${safeLabel} data source (up to 20 rows). ` +
                `Use query_data_source for filtered/aggregated queries.`,
              mimeType: 'application/json',
            };
          })
      : [];

    const staticResources = [
      {
        uri: 'studio://dashboard/state',
        name: 'Dashboard State',
        description:
          'The current x-studio dashboard state: pages, widgets, data sources, filters, and layout.',
        mimeType: 'application/json',
      },
      {
        uri: 'studio://dashboard/system-prompt',
        name: 'AI System Prompt',
        description:
          'The x-studio AI assistant system prompt, grounded in the current dashboard state. ' +
          'Useful for understanding the current context when building prompts.',
        mimeType: 'text/plain',
      },
      ...(data
        ? [
            {
              uri: 'studio://dashboard/data-health',
              name: 'Data Health',
              description:
                'Row counts for all configured data sources. ' +
                'Read this before querying to understand data scale.',
              mimeType: 'application/json',
            },
          ]
        : []),
    ];

    return { resources: [...staticResources, ...schemaResources, ...dataResources] };
  });

  // ── resources/read ───────────────────────────────────────────────────────

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'studio://dashboard/state') {
      // Same authorization chokepoint the `get_dashboard_state` TOOL passes
      // (finding 2.1): this resource returns the byte-identical `projectStateForAI`
      // payload, so excluding `get_dashboard_state` from `allowedTools` (or denying
      // it via `toolPolicy`) must block this read too — otherwise a host that hid the
      // tool would still leak the whole dashboard state through the resource surface.
      if (authorizeStateAccess) {
        const denied = await authorizeStateAccess();
        if (denied) {
          throw new Error(denied);
        }
      }
      // Serialize the AUTHORED document plus DATA-SOURCE METADATA ONLY — never the
      // raw `StudioState`. A host's state box can carry live `rows` (and a
      // non-serializable `adapter`) on `runtime.dataSources`; dumping them verbatim
      // is an exfiltration / token-bomb path with no `data`-config opt-in and no
      // cap (finding 2.2). `doc.ai` chat transcripts are likewise reduced to per-thread
      // metadata (finding 1.1). This calls the SAME `projectStateForAI` helper the
      // `get_dashboard_state` TOOL uses, so the `{ doc, dataSources }` redaction contract
      // (rows/adapter stripped, distinct values capped, `doc.ai` transcripts removed)
      // lives in exactly one place and the two read surfaces cannot drift.
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(projectStateForAI(stateBox.current), null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    }

    if (uri === 'studio://dashboard/system-prompt') {
      // Same `get_dashboard_state` gate as the raw state resource (finding 2.1): this
      // resource embeds the full `<dashboard_state>` block (the identical
      // `projectStateForAI` payload, just rendered as prompt text), so it must honor
      // the same authorization as the tool and the raw-state resource.
      if (authorizeStateAccess) {
        const denied = await authorizeStateAccess();
        if (denied) {
          throw new Error(denied);
        }
      }

      const dataToolNames = data
        ? ['query_data_source', 'describe_data_source', 'get_field_values', 'compute_field_stats']
        : undefined;

      // Distilled layout + cross-filter graph — pure structure, no rows needed.
      const pageLayout = buildPageLayoutContext(stateBox.current);
      const richContext = pageLayout ? { pageLayout } : undefined;

      // Best-effort server-side enrichment (row counts, schema comments).
      let enrichedContext: StudioAIEnrichedContext | undefined;
      if (contextEnricher) {
        // The `contextEnricher` runs LIVE DB queries (per-dimension row counts —
        // strictly finer-grained than the per-source COUNTs `data-health` returns), so
        // it must pass the SAME data-access chokepoint as `data-health` and the row
        // preview (finding 2.2). Only the ENRICHMENT is skipped when denied, not the
        // whole resource — the state-derived prompt is still served (already gated for
        // state access above), just without the extra live-query enrichment.
        const enrichDenied = authorizeDataAccess ? await authorizeDataAccess() : null;
        if (enrichDenied) {
          logger?.log(
            `[mcp] skipping contextEnricher for studio://dashboard/system-prompt: ${enrichDenied}`,
          );
        } else {
          try {
            // Bounded by `CONTEXT_ENRICHER_TIMEOUT_MS` (finding T2-2, iteration 25) —
            // this `await` previously had no timeout, so a hung enrichment DB query
            // would block this resource read indefinitely. Enrichment is best-effort,
            // so a timeout degrades the same way a thrown error already does: logged
            // and the resource is still served without it.
            enrichedContext = await withTimeout(
              Promise.resolve(
                contextEnricher({
                  dashboardState: stateBox.current,
                  richContext,
                }),
              ),
              CONTEXT_ENRICHER_TIMEOUT_MS,
              'contextEnricher',
            );
          } catch (err) {
            logger?.error(
              `[mcp] contextEnricher failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      return {
        contents: [
          {
            uri,
            text: buildAISystemPrompt(stateBox.current, customWidgets, undefined, undefined, {
              availableDataTools: dataToolNames,
              richContext,
              enrichedContext,
            }),
            mimeType: 'text/plain',
          },
        ],
      };
    }

    if (uri === 'studio://dashboard/data-health') {
      if (!data) {
        throw new Error('Data access is not configured for this MCP server instance.');
      }
      // Same authorization chokepoint the data TOOLS pass before running a live
      // query (finding 2.1): this resource runs one COUNT query per source, so it
      // must not bypass `allowedTools` / `toolPolicy`.
      if (authorizeDataAccess) {
        const denied = await authorizeDataAccess();
        if (denied) {
          throw new Error(denied);
        }
      }
      // Null-prototype accumulators (finding L1): both are keyed by a source id, and
      // a source id is host/model-supplied — a `__proto__` key would otherwise be a
      // silently-dropped prototype write rather than a reported entry.
      const counts: Record<string, number> = Object.create(null);
      const errors: Record<string, string> = Object.create(null);
      const allHealthSources = Object.values(stateBox.current.runtime.dataSources).filter(
        (s) => !s.hidden && s.tableName,
      );
      // Finding M8: bound the concurrent fan-out — see MAX_DATA_HEALTH_SOURCES.
      const sourcesTruncated = allHealthSources.length > MAX_DATA_HEALTH_SOURCES;
      const healthSources = sourcesTruncated
        ? allHealthSources.slice(0, MAX_DATA_HEALTH_SOURCES)
        : allHealthSources;
      await Promise.all(
        healthSources.map(async (s) => {
          try {
            // Same `allowedTables` allowlist check `resolveSource` (`queryTools.ts`)
            // applies before `query_data_source` et al. reach the database (Tier 3,
            // iteration 24, finding 4): this resource resolves `s.tableName` directly
            // from `runtime.dataSources` rather than through `resolveSource`, so
            // without this check it could query a table outside the host's
            // configured allowlist. Reported per-source via `errors`, exactly like a
            // query failure below, rather than failing the whole resource read.
            const tableCheckError = checkAllowedTable(
              s.id,
              s.tableName as string,
              data.allowedTables,
            );
            if (tableCheckError) {
              errors[s.id] = tableCheckError;
              return;
            }
            // Bounded with the same `withTimeout` pattern `mcp/summarisePage.ts` applies to
            // its own `data.queryDataSource` calls (Tier 3, iteration 22): without it, one
            // slow/hung source in this per-source `Promise.all` would keep the whole
            // `data-health` resource read hanging indefinitely.
            const result = await withTimeout(
              data.queryDataSource({
                sourceId: s.id,
                tableName: s.tableName as string,
                aggregations: [{ column: '*', func: 'count', alias: 'count' }],
                limit: 1,
              }),
              15_000,
              `data-health count query for ${s.tableName}`,
            );
            const row = result.rows[0];
            counts[s.id] = Number(row?.count ?? result.rowCount ?? 0);
          } catch (err) {
            // Finding H4: the raw driver/host error used to be embedded verbatim in
            // this payload (which is served to the model), leaking credentials, SQL,
            // and internal hostnames. Log it in full server-side; report only the
            // generic message + correlation id.
            errors[s.id] = redactedHostErrorMessage(
              'studio://dashboard/data-health count query',
              err,
              logger,
            );
          }
        }),
      );
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(
              {
                counts,
                ...(Object.keys(errors).length > 0 && { errors }),
                // Finding M8: tell the reader the counts are partial, mirroring
                // `describe_data_source`'s `statsTruncatedNote`.
                ...(sourcesTruncated && {
                  truncated: true,
                  truncatedNote:
                    `Row counts were computed for only the first ${MAX_DATA_HEALTH_SOURCES} of ` +
                    `${allHealthSources.length} queryable data sources. Read studio://data/{sourceId} ` +
                    'or call query_data_source for the remaining sources.',
                }),
              },
              null,
              2,
            ),
            mimeType: 'application/json',
          },
        ],
      };
    }

    // studio://schema/{sourceId} — field metadata for a specific source
    if (uri.startsWith('studio://schema/')) {
      // Same `get_dashboard_state` gate the raw-state and system-prompt resources run
      // (finding T2-1): this branch serves a per-source slice of the SAME
      // `projectStateForAI` payload — `sampleValues` (up to 8 real, row-derived distinct
      // values per field) and the `serializeFieldForAI` string are not "static field
      // metadata", they are the exact row-derived category `get_dashboard_state` caps and
      // `privateModeExcluded` treats as sensitive. Without this gate, a host that excludes
      // `get_dashboard_state` from `allowedTools` (or denies it via `toolPolicy`) would
      // still leak the full schema catalogue — plus real sample data — by enumerating
      // `resources/list` (ungated by design) and reading `studio://schema/<id>` per source.
      if (authorizeStateAccess) {
        const denied = await authorizeStateAccess();
        if (denied) {
          throw new Error(denied);
        }
      }
      const sourceId = uri.slice('studio://schema/'.length);
      // `dataSources` is a plain object, so a bare `!source` falsy check does not catch a
      // `sourceId` naming an `Object.prototype` member (e.g. "constructor", "toString"),
      // which resolves via the prototype chain to a truthy non-source value and would then
      // throw an opaque `TypeError` on `source.fields.filter(...)` below (finding T2-4).
      // `Object.hasOwn` only matches an actual own entry in the map, matching the
      // `Object.hasOwn` guards used throughout the schema package's reducer.
      if (!Object.hasOwn(stateBox.current.runtime.dataSources, sourceId)) {
        // `safeIdentifier` (finding M7): `sourceId` is the client-supplied tail of the
        // URI and was echoed here neither sanitized NOR capped — so
        // `resources/read studio://schema/x</result>\n\nSYSTEM: …` was reproduced
        // verbatim in an error string most MCP clients splice into the model
        // conversation. `resolveSource` (`mcp/queryTools.ts`) already caps its
        // identical message; this is the same class.
        throw new Error(
          `Unknown data source: "${safeIdentifier(sourceId)}". Check studio://dashboard/state for available source IDs.`,
        );
      }
      const source = stateBox.current.runtime.dataSources[sourceId];
      const visibleFields = source.fields.filter((f) => !f.hidden);
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(
              {
                id: source.id,
                label: source.label,
                tableName: source.tableName,
                description: source.aiDescription,
                fields: visibleFields.map((f) => {
                  // `Object.hasOwn` + `Array.isArray`-guarded lookup (finding M1): a
                  // field id that is an `Object.prototype` member (a DB column named
                  // `constructor`) previously resolved `Object` off the prototype
                  // chain, passed the `≤ 8` gate, and threw
                  // `TypeError: distinctValues.map is not a function` inside
                  // `serializeFieldForAI` — failing every read of that source.
                  const distinctValues = ownArrayEntry(source.fieldDistinctValues, f.id);
                  return {
                    id: f.id,
                    label: f.label,
                    type: f.type,
                    ...(f.format && { format: f.format }),
                    ...(f.capabilities?.length && { capabilities: f.capabilities }),
                    ...(f.defaultAggregationFn && {
                      defaultAggregationFn: f.defaultAggregationFn,
                    }),
                    ...(f.aiDescription && { description: f.aiDescription }),
                    ...(distinctValues && { sampleValues: distinctValues.slice(0, 8) }),
                    serialized: serializeFieldForAI(f, distinctValues),
                  };
                }),
              },
              null,
              2,
            ),
            mimeType: 'application/json',
          },
        ],
      };
    }

    // studio://data/{sourceId} — raw row preview (up to 20 rows)
    if (uri.startsWith('studio://data/')) {
      if (!data) {
        throw new Error('Data access is not configured for this MCP server instance.');
      }
      // Parse the `sourceId` BEFORE gating so it can be threaded into the policy
      // consult (finding 2.3) — a per-source `toolPolicy` rule or an `approvalHandler`
      // that inspects `ctx.input` would otherwise be blind on this read.
      const sourceId = uri.slice('studio://data/'.length);
      // Same authorization chokepoint the data TOOLS pass before returning rows
      // (finding 2.1): this resource serves up to 20 raw rows, so it must not
      // bypass `allowedTools` / `toolPolicy`.
      if (authorizeDataAccess) {
        const denied = await authorizeDataAccess({ sourceId });
        if (denied) {
          throw new Error(denied);
        }
      }
      // `Object.hasOwn`-guarded lookup (finding T2-1): a prototype-member sourceId
      // must not resolve an inherited value via the prototype chain.
      const dataSources = stateBox.current.runtime.dataSources;
      const source = Object.hasOwn(dataSources, sourceId) ? dataSources[sourceId] : undefined;
      if (!source || !source.tableName) {
        // Sanitized + capped before echoing (finding M7) — see the identical
        // `studio://schema/{id}` message above.
        throw new Error(
          `Unknown data source: "${safeIdentifier(sourceId)}". Check studio://dashboard/state for available source IDs.`,
        );
      }
      // Same `allowedTables` allowlist check `resolveSource` (`queryTools.ts`) applies
      // before `query_data_source` et al. reach the database (Tier 3, iteration 24,
      // finding 4): this resource resolves `source.tableName` directly from
      // `runtime.dataSources` rather than through `resolveSource`, so without this
      // check it could query a table outside the host's configured allowlist.
      const tableCheckError = checkAllowedTable(sourceId, source.tableName, data.allowedTables);
      if (tableCheckError) {
        throw new Error(tableCheckError);
      }
      // Bounded with the same `withTimeout` pattern `mcp/summarisePage.ts` applies to its
      // own `data.queryDataSource` calls (Tier 3, iteration 22) — otherwise a hung host
      // query implementation would leave this resource read pending indefinitely.
      //
      // Finding H4: this was the one live-query site with NO try/catch at all, so a
      // rejection propagated out of the handler and the MCP SDK returned `err.message`
      // — the raw driver text — to the client. Catch it, log the detail server-side,
      // and surface the same generic message + correlation id every other data path
      // now returns.
      let result: StudioDataQueryResult;
      try {
        result = await withTimeout(
          data.queryDataSource({
            sourceId,
            tableName: source.tableName as string,
            limit: 20,
          }),
          15_000,
          `row preview query for ${source.tableName}`,
        );
      } catch (err) {
        throw new Error(redactedHostErrorMessage('studio://data row preview query', err, logger));
      }
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(
              { sourceId, label: source.label, rowCount: result.rowCount, rows: result.rows },
              null,
              2,
            ),
            mimeType: 'application/json',
          },
        ],
      };
    }

    // Sanitized + capped before echoing (finding M7): `uri` is entirely
    // client-supplied and unbounded, and this message lands in the same
    // model-visible position as the unknown-source ones above.
    throw new Error(
      `Unknown resource URI: "${safeIdentifier(uri)}". Use resources/list to discover available URIs.`,
    );
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const { uri } = request.params;

    // Reject anything `resources/read` could never actually serve — mirrors the
    // unknown-URI behavior there (throwing, not silently returning `{}`, so the
    // client gets real feedback instead of believing it is subscribed).
    if (!isKnownResourceUri(uri)) {
      // Sanitized + capped before echoing (finding M7) — same class as the
      // `resources/read` messages above.
      throw new Error(
        `Cannot subscribe to unknown resource URI: "${safeIdentifier(uri)}". Use resources/list to discover available URIs.`,
      );
    }

    // Prefix validation alone doesn't bound the set (a client can still spam
    // distinct valid-shaped URIs, e.g. `studio://schema/<garbage-N>` for many
    // N) — enforce a hard cap. Re-subscribing an already-tracked URI is always
    // allowed even at capacity.
    if (!subscribedUris.has(uri) && subscribedUris.size >= maxSubscribedUris) {
      throw new Error(
        `Cannot subscribe to "${safeIdentifier(uri)}": this session has reached its limit of ${maxSubscribedUris} subscribed resource URIs.`,
      );
    }

    subscribedUris.add(uri);
    // Immediately notify so clients that wait for a push before reading (e.g. the
    // MCP Inspector in proxy mode) get the current value right after subscribing.
    server.sendResourceUpdated({ uri }).catch(() => {});
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscribedUris.delete(request.params.uri);
    return {};
  });
}
