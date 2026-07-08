/**
 * Unit tests for `mcp/resources.ts`.
 *
 * The subscribe/unsubscribe coverage in the top-level `mcp.test.ts` only
 * exercises the "handler exists and runs" happy path through the full
 * `buildStudioMcpServer` composition root, with no way to assert on
 * `subscribedUris` membership directly. This file exercises
 * `registerResourceHandlers` directly against a locally constructed
 * `subscribedUris` set so the validation + bound added for finding 4.7 can be
 * asserted precisely.
 *
 * It also covers the two Tier-2 resource-surface security fixes:
 * - finding 2.1: `resources/read` for the two live-query URI families
 *   (`studio://data/{id}`, `studio://dashboard/data-health`) must pass the SAME
 *   authorization gate as the data tools — driven end-to-end through
 *   `buildStudioMcpServer` with real `allowedTools` / `toolPolicy` restrictions.
 * - finding 2.2: `studio://dashboard/state` must never serialize raw
 *   `runtime.dataSources` rows / adapter, mirroring the `get_dashboard_state`
 *   tool's redaction contract.
 */

import { describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { registerResourceHandlers } from './resources';
import { buildStudioMcpServer } from '../mcp';
import { createDefaultStudioState } from '../models/studioTypes';
import type { StudioDataSource } from '../models/studioTypes';
import type { StudioMcpData, StudioStateBox } from './types';

const SUBSCRIBE = 'resources/subscribe';
const UNSUBSCRIBE = 'resources/unsubscribe';
const READ = 'resources/read';
const PAGE_ID = 'page-1';

/** Access the internal handler map on the low-level Server object. */
function getHandler(
  server: Server,
  method: string,
): (req: { params: Record<string, unknown>; method: string }) => Promise<unknown> {
  // eslint-disable-next-line no-underscore-dangle
  const handlers = (server as any)._requestHandlers as Map<string, (req: any) => Promise<unknown>>;
  const h = handlers?.get(method);
  if (!h) {
    throw new Error(`No handler registered for "${method}"`);
  }
  return h;
}

function makeSource(overrides?: Partial<StudioDataSource>): StudioDataSource {
  return {
    id: 'source-orders',
    label: 'Orders',
    tableName: 'orders',
    fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
    ...overrides,
  } as StudioDataSource;
}

function makeStateBox(): StudioStateBox {
  return {
    current: createDefaultStudioState({
      doc: {
        dashboard: { id: 'd1', title: 'Test', activePageId: PAGE_ID },
        pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [] } },
      },
      runtime: {
        dataSources: { 'source-orders': makeSource() },
      },
    }),
  };
}

/** Build a bare `Server` with `registerResourceHandlers` wired up, plus the
 * locally constructed `subscribedUris` set so membership can be asserted. */
function makeServer(maxSubscribedUris?: number) {
  const server = new Server(
    { name: 'test', version: '1.0.0' },
    { capabilities: { resources: { subscribe: true } } },
  );
  const subscribedUris = new Set<string>();
  registerResourceHandlers(server, {
    stateBox: makeStateBox(),
    customWidgets: [],
    subscribedUris,
    ...(maxSubscribedUris !== undefined && { maxSubscribedUris }),
  });
  return { server, subscribedUris };
}

describe('resources/subscribe', () => {
  it('accepts a subscribe to studio://dashboard/state', async () => {
    const { server, subscribedUris } = makeServer();
    const result = await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://dashboard/state' },
      method: SUBSCRIBE,
    });
    expect(result).toBeDefined();
    expect(subscribedUris.has('studio://dashboard/state')).toBe(true);
  });

  it('accepts subscribes to studio://schema/{id} and studio://data/{id}', async () => {
    const { server, subscribedUris } = makeServer();
    await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://schema/source-orders' },
      method: SUBSCRIBE,
    });
    await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://data/source-orders' },
      method: SUBSCRIBE,
    });
    expect(subscribedUris.has('studio://schema/source-orders')).toBe(true);
    expect(subscribedUris.has('studio://data/source-orders')).toBe(true);
  });

  it.each([
    ['https://evil.example/x'],
    ['not-a-uri'],
    ['studio://bogus/thing'],
    ['studio://schema/'],
    ['studio://data/'],
  ])('rejects subscribing to %s and leaves the set unchanged', async (uri) => {
    const { server, subscribedUris } = makeServer();
    await expect(
      getHandler(server, SUBSCRIBE)({ params: { uri }, method: SUBSCRIBE }),
    ).rejects.toThrow(/Cannot subscribe to unknown resource URI/);
    expect(subscribedUris.size).toBe(0);
  });

  it('rejects a new URI once maxSubscribedUris is reached, but still allows re-subscribing an existing member', async () => {
    const { server, subscribedUris } = makeServer(3);
    await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://dashboard/state' },
      method: SUBSCRIBE,
    });
    await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://dashboard/system-prompt' },
      method: SUBSCRIBE,
    });
    await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://schema/source-orders' },
      method: SUBSCRIBE,
    });
    expect(subscribedUris.size).toBe(3);

    // A 4th distinct valid URI is rejected — the set is at capacity.
    await expect(
      getHandler(
        server,
        SUBSCRIBE,
      )({
        params: { uri: 'studio://data/source-orders' },
        method: SUBSCRIBE,
      }),
    ).rejects.toThrow(/reached its limit/);
    expect(subscribedUris.size).toBe(3);

    // Re-subscribing an existing member still succeeds even at capacity.
    const result = await getHandler(
      server,
      SUBSCRIBE,
    )({
      params: { uri: 'studio://dashboard/state' },
      method: SUBSCRIBE,
    });
    expect(result).toBeDefined();
    expect(subscribedUris.size).toBe(3);
  });
});

describe('resources/unsubscribe', () => {
  it('unsubscribing a never-subscribed URI is a harmless no-op', async () => {
    const { server, subscribedUris } = makeServer();
    const result = await getHandler(
      server,
      UNSUBSCRIBE,
    )({
      params: { uri: 'studio://dashboard/state' },
      method: UNSUBSCRIBE,
    });
    expect(result).toBeDefined();
    expect(subscribedUris.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// finding 2.1 — MCP resource reads must pass the same authorization gate as tools
// ─────────────────────────────────────────────────────────────────────────────

/** A `data` config whose `queryDataSource` returns a fixed row/count payload. */
function makeData(): StudioMcpData & { queryDataSource: ReturnType<typeof vi.fn> } {
  const queryDataSource = vi.fn(async (params: any) => {
    // `data-health` sends a count aggregation; the row preview does not.
    if (params.aggregations) {
      return { rows: [{ count: 42 }], rowCount: 1 };
    }
    return { rows: [{ id: 'o1', total: 100 }], rowCount: 1 };
  });
  return { queryDataSource };
}

/** Invoke a `resources/read` handler on a full `buildStudioMcpServer` server. */
function readResource(server: Server, uri: string) {
  return getHandler(server, READ)({ params: { uri }, method: READ }) as Promise<{
    contents: { uri: string; text: string; mimeType: string }[];
  }>;
}

describe('resources/read data-access authorization (finding 2.1)', () => {
  it('denies studio://data/{id} when allowedTools excludes the data tools', async () => {
    const data = makeData();
    // A metadata-only integration: no data-returning tool allowed.
    const server = buildStudioMcpServer(makeStateBox(), {
      data,
      allowedTools: ['get_dashboard_state', 'list_pages'],
    });
    await expect(readResource(server, 'studio://data/source-orders')).rejects.toThrow(
      /allowedTools|query_data_source/,
    );
    // The live query must never have run.
    expect(data.queryDataSource).not.toHaveBeenCalled();
  });

  it('denies studio://dashboard/data-health when allowedTools excludes the data tools', async () => {
    const data = makeData();
    const server = buildStudioMcpServer(makeStateBox(), {
      data,
      allowedTools: ['get_dashboard_state', 'list_pages'],
    });
    await expect(readResource(server, 'studio://dashboard/data-health')).rejects.toThrow(
      /allowedTools|query_data_source/,
    );
    expect(data.queryDataSource).not.toHaveBeenCalled();
  });

  it('denies both live-query resources when toolPolicy denies query_data_source', async () => {
    const data = makeData();
    const server = buildStudioMcpServer(makeStateBox(), {
      data,
      toolPolicy: (ctx) =>
        ctx.toolName === 'query_data_source'
          ? { action: 'deny', reason: 'policy: no raw data' }
          : { action: 'allow' },
    });
    await expect(readResource(server, 'studio://data/source-orders')).rejects.toThrow(
      /policy: no raw data/,
    );
    await expect(readResource(server, 'studio://dashboard/data-health')).rejects.toThrow(
      /policy: no raw data/,
    );
    expect(data.queryDataSource).not.toHaveBeenCalled();
  });

  it('serves studio://data/{id} and data-health when query_data_source is allowed (no regression)', async () => {
    const data = makeData();
    const server = buildStudioMcpServer(makeStateBox(), {
      data,
      allowedTools: ['query_data_source'],
    });

    const preview = await readResource(server, 'studio://data/source-orders');
    const previewPayload = JSON.parse(preview.contents[0].text);
    expect(previewPayload.rows).toEqual([{ id: 'o1', total: 100 }]);

    const health = await readResource(server, 'studio://dashboard/data-health');
    const healthPayload = JSON.parse(health.contents[0].text);
    expect(healthPayload.counts['source-orders']).toBe(42);

    expect(data.queryDataSource).toHaveBeenCalledTimes(2);
  });

  it('serves both live-query resources under the default allow-all policy (no regression)', async () => {
    // No allowedTools, no toolPolicy — historical "execute everything" behavior.
    const data = makeData();
    const server = buildStudioMcpServer(makeStateBox(), { data });

    const preview = await readResource(server, 'studio://data/source-orders');
    expect(JSON.parse(preview.contents[0].text).rows).toEqual([{ id: 'o1', total: 100 }]);

    const health = await readResource(server, 'studio://dashboard/data-health');
    expect(JSON.parse(health.contents[0].text).counts['source-orders']).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// finding 2.2 — studio://dashboard/state must never serve raw rows / adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('resources/read studio://dashboard/state redaction (finding 2.2)', () => {
  /** A source carrying the things a state dump must NOT leak: raw `rows`, a
   * non-serializable `adapter`, and an over-cap `fieldDistinctValues` list. */
  function makeSourceWithRows(): StudioDataSource {
    return {
      id: 'source-orders',
      label: 'Orders',
      tableName: 'orders',
      fields: [{ id: 'status', label: 'Status', type: 'string' }],
      rows: [
        { id: 'o1', ssn: 'SECRET-123-45-6789' },
        { id: 'o2', ssn: 'SECRET-987-65-4321' },
      ],
      adapter: () => undefined,
      fieldDistinctValues: {
        status: Array.from({ length: 50 }, (_, i) => `value-${i}`),
      },
    } as unknown as StudioDataSource;
  }

  function makeServerWithRows() {
    const server = new Server(
      { name: 'test', version: '1.0.0' },
      { capabilities: { resources: { subscribe: true } } },
    );
    const stateBox: StudioStateBox = {
      current: createDefaultStudioState({
        doc: {
          dashboard: { id: 'd1', title: 'Test', activePageId: PAGE_ID },
          pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [] } },
        },
        runtime: { dataSources: { 'source-orders': makeSourceWithRows() } },
      }),
    };
    registerResourceHandlers(server, { stateBox, customWidgets: [], subscribedUris: new Set() });
    return server;
  }

  it('emits { doc, dataSources } with rows and adapter stripped and distinct values capped', async () => {
    const server = makeServerWithRows();
    const result = (await getHandler(
      server,
      READ,
    )({
      params: { uri: 'studio://dashboard/state' },
      method: READ,
    })) as { contents: { text: string }[] };

    const text = result.contents[0].text;
    // Raw row values must not appear anywhere in the serialized payload.
    expect(text).not.toContain('SECRET-123-45-6789');
    expect(text).not.toContain('SECRET-987-65-4321');

    const payload = JSON.parse(text);
    // Mirrors the get_dashboard_state tool output contract: { doc, dataSources }.
    expect(payload.doc).toBeDefined();
    expect(payload.dataSources).toBeDefined();

    const src = payload.dataSources['source-orders'];
    expect(src.rows).toBeUndefined();
    expect(src.adapter).toBeUndefined();
    // fieldDistinctValues capped the same way the tool caps it (20 + truncated flag).
    expect(src.fieldDistinctValues.status.values).toHaveLength(20);
    expect(src.fieldDistinctValues.status.truncated).toBe(true);
    // Field metadata is still present (this is the useful, safe part).
    expect(src.fields).toEqual([{ id: 'status', label: 'Status', type: 'string' }]);
  });
});
