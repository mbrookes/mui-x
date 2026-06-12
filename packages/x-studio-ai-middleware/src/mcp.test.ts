/**
 * Unit tests for buildStudioMcpServer — Phase 2 features:
 * - resources/list: static + schema resources + data-health
 * - resources/read: schema, data-health, state, system-prompt
 * - resources/subscribe + unsubscribe
 * - Mutation notifications to subscribed URIs
 */

import { describe, expect, it, vi } from 'vitest';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { buildStudioMcpServer } from './mcp';
import { createDefaultStudioState } from './models/studioTypes';
import type { StudioDataSource } from './models/studioTypes';
import type { StudioDataQueryParams, StudioDataQueryResult } from './mcp';

/** Access the internal handler map on the low-level Server object */
function getHandler(
  server: Server,
  method: string,
): (req: { params: Record<string, unknown>; method: string }) => Promise<unknown> {
  const handlers = (server as any)._requestHandlers as Map<string, (req: any) => Promise<unknown>>;
  const h = handlers?.get(method);
  if (!h) throw new Error(`No handler registered for "${method}"`);
  return h;
}

const LIST_RESOURCES = 'resources/list';
const READ_RESOURCE = 'resources/read';
const SUBSCRIBE = 'resources/subscribe';
const UNSUBSCRIBE = 'resources/unsubscribe';

const PAGE_ID = 'page-1';

function makeSource(overrides?: Partial<StudioDataSource>): StudioDataSource {
  return {
    id: 'source-orders',
    label: 'Orders',
    tableName: 'orders',
    fields: [
      { id: 'id', label: 'Order ID', type: 'string' },
      { id: 'total', label: 'Total', type: 'number', format: 'currency', defaultAggregationFn: 'sum' },
      { id: 'status', label: 'Status', type: 'string' },
    ],
    fieldDistinctValues: {
      status: ['pending', 'shipped', 'delivered'],
    },
    ...overrides,
  } as StudioDataSource;
}

function makeStableState() {
  const state = createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Test', activePageId: PAGE_ID },
    pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [] } },
    dataSources: { 'source-orders': makeSource() },
  });
  return state;
}

describe('buildStudioMcpServer', () => {
  describe('resources/list', () => {
    it('includes static resources', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(server, LIST_RESOURCES)({ params: {}, method: LIST_RESOURCES });
      const resources = (result as any).resources as Array<{ uri: string }>;
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain('studio://dashboard/state');
      expect(uris).toContain('studio://dashboard/system-prompt');
    });

    it('includes schema resource for each data source', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(server, LIST_RESOURCES)({ params: {}, method: LIST_RESOURCES });
      const resources = (result as any).resources as Array<{ uri: string }>;
      expect(resources.map((r) => r.uri)).toContain('studio://schema/source-orders');
    });

    it('includes data-health when data option is provided', async () => {
      const stateBox = { current: makeStableState() };
      const queryDataSource = vi.fn(
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({ rows: [{ count: 42 }], rowCount: 1 }),
      );
      const server = buildStudioMcpServer(stateBox, { data: { queryDataSource } });
      const result = await getHandler(server, LIST_RESOURCES)({ params: {}, method: LIST_RESOURCES });
      const resources = (result as any).resources as Array<{ uri: string }>;
      expect(resources.map((r) => r.uri)).toContain('studio://dashboard/data-health');
    });

    it('omits data-health when no data option', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(server, LIST_RESOURCES)({ params: {}, method: LIST_RESOURCES });
      const resources = (result as any).resources as Array<{ uri: string }>;
      expect(resources.map((r) => r.uri)).not.toContain('studio://dashboard/data-health');
    });
  });

  describe('resources/read', () => {
    it('reads studio://schema/{sourceId} with field metadata', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(server, READ_RESOURCE)({
        params: { uri: 'studio://schema/source-orders' },
        method: READ_RESOURCE,
      });
      const contents = (result as any).contents as Array<{ text: string; mimeType: string }>;
      expect(contents[0].mimeType).toBe('application/json');
      const parsed = JSON.parse(contents[0].text);
      expect(parsed.id).toBe('source-orders');
      expect(parsed.fields).toHaveLength(3);
      const totalField = parsed.fields.find((f: any) => f.id === 'total');
      expect(totalField.format).toBe('currency');
      expect(totalField.defaultAggregationFn).toBe('sum');
      const statusField = parsed.fields.find((f: any) => f.id === 'status');
      expect(statusField.sampleValues).toContain('pending');
    });

    it('reads studio://dashboard/data-health with row counts', async () => {
      const stateBox = { current: makeStableState() };
      const queryDataSource = vi.fn(
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({ rows: [{ count: 99 }], rowCount: 1 }),
      );
      const server = buildStudioMcpServer(stateBox, { data: { queryDataSource } });
      const result = await getHandler(server, READ_RESOURCE)({
        params: { uri: 'studio://dashboard/data-health' },
        method: READ_RESOURCE,
      });
      const contents = (result as any).contents as Array<{ text: string }>;
      const parsed = JSON.parse(contents[0].text);
      expect(parsed.counts['source-orders']).toBe(99);
    });

    it('throws on unknown resource URI with helpful message', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      await expect(
        getHandler(server, READ_RESOURCE)({
          params: { uri: 'studio://nonexistent/foo' },
          method: READ_RESOURCE,
        }),
      ).rejects.toThrow(/Unknown resource URI/);
    });
  });

  describe('resources/subscribe + unsubscribe', () => {
    it('subscribe and unsubscribe handlers exist and run without error', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const subscribeHandler = getHandler(server, SUBSCRIBE);
      const unsubscribeHandler = getHandler(server, UNSUBSCRIBE);

      await subscribeHandler({ params: { uri: 'studio://dashboard/state' }, method: SUBSCRIBE });
      await unsubscribeHandler({ params: { uri: 'studio://dashboard/state' }, method: UNSUBSCRIBE });
    });
  });
});
