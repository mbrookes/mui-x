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
import type { StudioMcpData, StudioMcpLogger, StudioMcpOptions, StudioStateBox } from './types';

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
            enrichedContext = await contextEnricher({
              dashboardState: stateBox.current,
              richContext,
            });
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
      const counts: Record<string, number> = {};
      const errors: Record<string, string> = {};
      await Promise.all(
        Object.values(stateBox.current.runtime.dataSources)
          .filter((s) => !s.hidden && s.tableName)
          .map(async (s) => {
            try {
              const result = await data.queryDataSource({
                sourceId: s.id,
                tableName: s.tableName as string,
                aggregations: [{ column: '*', func: 'count', alias: 'count' }],
                limit: 1,
              });
              const row = result.rows[0];
              counts[s.id] = Number(row?.count ?? result.rowCount ?? 0);
            } catch (err) {
              errors[s.id] = String(err);
            }
          }),
      );
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(
              { counts, ...(Object.keys(errors).length > 0 && { errors }) },
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
        throw new Error(
          `Unknown data source: "${sourceId}". Check studio://dashboard/state for available source IDs.`,
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
                fields: visibleFields.map((f) => ({
                  id: f.id,
                  label: f.label,
                  type: f.type,
                  ...(f.format && { format: f.format }),
                  ...(f.capabilities?.length && { capabilities: f.capabilities }),
                  ...(f.defaultAggregationFn && { defaultAggregationFn: f.defaultAggregationFn }),
                  ...(f.aiDescription && { description: f.aiDescription }),
                  ...(source.fieldDistinctValues?.[f.id] && {
                    sampleValues: source.fieldDistinctValues[f.id].slice(0, 8),
                  }),
                  serialized: serializeFieldForAI(f, source.fieldDistinctValues?.[f.id]),
                })),
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
      const source = stateBox.current.runtime.dataSources[sourceId];
      if (!source || !source.tableName) {
        throw new Error(
          `Unknown data source: "${sourceId}". Check studio://dashboard/state for available source IDs.`,
        );
      }
      const result = await data.queryDataSource({
        sourceId,
        tableName: source.tableName as string,
        limit: 20,
      });
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

    throw new Error(
      `Unknown resource URI: "${uri}". Use resources/list to discover available URIs.`,
    );
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const { uri } = request.params;

    // Reject anything `resources/read` could never actually serve — mirrors the
    // unknown-URI behavior there (throwing, not silently returning `{}`, so the
    // client gets real feedback instead of believing it is subscribed).
    if (!isKnownResourceUri(uri)) {
      throw new Error(
        `Cannot subscribe to unknown resource URI: "${uri}". Use resources/list to discover available URIs.`,
      );
    }

    // Prefix validation alone doesn't bound the set (a client can still spam
    // distinct valid-shaped URIs, e.g. `studio://schema/<garbage-N>` for many
    // N) — enforce a hard cap. Re-subscribing an already-tracked URI is always
    // allowed even at capacity.
    if (!subscribedUris.has(uri) && subscribedUris.size >= maxSubscribedUris) {
      throw new Error(
        `Cannot subscribe to "${uri}": this session has reached its limit of ${maxSubscribedUris} subscribed resource URIs.`,
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
