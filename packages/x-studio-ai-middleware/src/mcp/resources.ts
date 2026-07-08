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
import { buildAISystemPrompt, serializeFieldForAI } from '../buildAISystemPrompt';
import { buildPageLayoutContext } from '../buildPageLayoutContext';
import { projectDataSourceMetadata } from '../executeToolOnState';
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
   */
  authorizeDataAccess?: () => Promise<string | null>;
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

    const schemaResources = sources.map((s) => ({
      uri: `studio://schema/${s.id}`,
      name: `${s.label} Schema`,
      description: `Field definitions for the ${s.label} data source (sourceId: "${s.id}").`,
      mimeType: 'application/json',
    }));

    const dataResources = data
      ? sources
          .filter((s) => s.tableName)
          .map((s) => ({
            uri: `studio://data/${s.id}`,
            name: `${s.label} Preview`,
            description:
              `Raw row preview for the ${s.label} data source (up to 20 rows). ` +
              `Use query_data_source for filtered/aggregated queries.`,
            mimeType: 'application/json',
          }))
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
      // Serialize the AUTHORED document plus DATA-SOURCE METADATA ONLY — never the
      // raw `StudioState`. A host's state box can carry live `rows` (and a
      // non-serializable `adapter`) on `runtime.dataSources`; dumping them verbatim
      // is an exfiltration / token-bomb path with no `data`-config opt-in and no
      // cap (finding 2.2). This mirrors the `get_dashboard_state` TOOL's output
      // contract exactly (`executeToolOnState.ts`): `{ doc, dataSources }` with each
      // source projected through `projectDataSourceMetadata` (strips `rows`/`adapter`,
      // caps `fieldDistinctValues`).
      const dataSources: Record<string, unknown> = {};
      for (const [id, source] of Object.entries(stateBox.current.runtime.dataSources)) {
        dataSources[id] = projectDataSourceMetadata(source);
      }
      return {
        contents: [
          {
            uri,
            text: JSON.stringify({ doc: stateBox.current.doc, dataSources }, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    }

    if (uri === 'studio://dashboard/system-prompt') {
      const dataToolNames = data
        ? ['query_data_source', 'describe_data_source', 'get_field_values', 'compute_field_stats']
        : undefined;

      // Distilled layout + cross-filter graph — pure structure, no rows needed.
      const pageLayout = buildPageLayoutContext(stateBox.current);
      const richContext = pageLayout ? { pageLayout } : undefined;

      // Best-effort server-side enrichment (row counts, schema comments).
      let enrichedContext: StudioAIEnrichedContext | undefined;
      if (contextEnricher) {
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
      const sourceId = uri.slice('studio://schema/'.length);
      const source = stateBox.current.runtime.dataSources[sourceId];
      if (!source) {
        throw new Error(
          `Unknown data source: "${sourceId}". Check studio://dashboard/state for available source IDs.`,
        );
      }
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
      // Same authorization chokepoint the data TOOLS pass before returning rows
      // (finding 2.1): this resource serves up to 20 raw rows, so it must not
      // bypass `allowedTools` / `toolPolicy`.
      if (authorizeDataAccess) {
        const denied = await authorizeDataAccess();
        if (denied) {
          throw new Error(denied);
        }
      }
      const sourceId = uri.slice('studio://data/'.length);
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
