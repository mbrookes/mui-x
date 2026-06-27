/**
 * Unit tests for buildStudioMcpServer:
 * - resources/list: static + schema + data preview + data-health resources
 * - resources/read: state, system-prompt, schema, data-health, data preview
 * - resources/subscribe + unsubscribe
 * - prompts/list + prompts/get (query_data_source_examples)
 * - completion/complete (URI autocomplete for schema + data URIs)
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
  // eslint-disable-next-line no-underscore-dangle
  const handlers = (server as any)._requestHandlers as Map<string, (req: any) => Promise<unknown>>;
  const h = handlers?.get(method);
  if (!h) {
    throw new Error(`No handler registered for "${method}"`);
  }
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
      {
        id: 'total',
        label: 'Total',
        type: 'number',
        format: 'currency',
        defaultAggregationFn: 'sum',
      },
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
      const result = await getHandler(
        server,
        LIST_RESOURCES,
      )({ params: {}, method: LIST_RESOURCES });
      const resources = (result as any).resources as Array<{ uri: string }>;
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain('studio://dashboard/state');
      expect(uris).toContain('studio://dashboard/system-prompt');
    });

    it('includes schema resource for each data source', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(
        server,
        LIST_RESOURCES,
      )({ params: {}, method: LIST_RESOURCES });
      const resources = (result as any).resources as Array<{ uri: string }>;
      expect(resources.map((r) => r.uri)).toContain('studio://schema/source-orders');
    });

    it('includes data-health when data option is provided', async () => {
      const stateBox = { current: makeStableState() };
      const queryDataSource = vi.fn(
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
          rows: [{ count: 42 }],
          rowCount: 1,
        }),
      );
      const server = buildStudioMcpServer(stateBox, { data: { queryDataSource } });
      const result = await getHandler(
        server,
        LIST_RESOURCES,
      )({ params: {}, method: LIST_RESOURCES });
      const resources = (result as any).resources as Array<{ uri: string }>;
      expect(resources.map((r) => r.uri)).toContain('studio://dashboard/data-health');
    });

    it('omits data-health when no data option', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(
        server,
        LIST_RESOURCES,
      )({ params: {}, method: LIST_RESOURCES });
      const resources = (result as any).resources as Array<{ uri: string }>;
      expect(resources.map((r) => r.uri)).not.toContain('studio://dashboard/data-health');
    });
  });

  describe('resources/read', () => {
    it('reads studio://schema/{sourceId} with field metadata', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(
        server,
        READ_RESOURCE,
      )({
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
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
          rows: [{ count: 99 }],
          rowCount: 1,
        }),
      );
      const server = buildStudioMcpServer(stateBox, { data: { queryDataSource } });
      const result = await getHandler(
        server,
        READ_RESOURCE,
      )({
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
        getHandler(
          server,
          READ_RESOURCE,
        )({
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

      const subscribeResult = await subscribeHandler({
        params: { uri: 'studio://dashboard/state' },
        method: SUBSCRIBE,
      });
      const unsubscribeResult = await unsubscribeHandler({
        params: { uri: 'studio://dashboard/state' },
        method: UNSUBSCRIBE,
      });
      expect(subscribeResult).toBeDefined();
      expect(unsubscribeResult).toBeDefined();
    });
  });

  describe('studio://data/{sourceId} resource', () => {
    it('returns raw row preview with row count', async () => {
      const stateBox = { current: makeStableState() };
      const sampleRows = [{ id: 'o1', total: 100, status: 'pending' }];
      const queryDataSource = vi.fn(
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
          rows: sampleRows,
          rowCount: 1,
        }),
      );
      const server = buildStudioMcpServer(stateBox, { data: { queryDataSource } });
      const result = await getHandler(
        server,
        READ_RESOURCE,
      )({
        params: { uri: 'studio://data/source-orders' },
        method: READ_RESOURCE,
      });
      const contents = (result as any).contents as Array<{ text: string }>;
      const parsed = JSON.parse(contents[0].text);
      expect(parsed.sourceId).toBe('source-orders');
      expect(parsed.rows).toHaveLength(1);
      expect(queryDataSource).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: 'source-orders', limit: 20 }),
      );
    });

    it('is listed in resources when data option provided', async () => {
      const stateBox = { current: makeStableState() };
      const queryDataSource = vi.fn(
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
          rows: [],
          rowCount: 0,
        }),
      );
      const server = buildStudioMcpServer(stateBox, { data: { queryDataSource } });
      const result = await getHandler(
        server,
        LIST_RESOURCES,
      )({ params: {}, method: LIST_RESOURCES });
      const uris = ((result as any).resources as Array<{ uri: string }>).map((r) => r.uri);
      expect(uris).toContain('studio://data/source-orders');
    });

    it('is NOT listed when no data option', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(
        server,
        LIST_RESOURCES,
      )({ params: {}, method: LIST_RESOURCES });
      const uris = ((result as any).resources as Array<{ uri: string }>).map((r) => r.uri);
      expect(uris).not.toContain('studio://data/source-orders');
    });
  });

  describe('query_data_source tool — limit clamping', () => {
    const CALL_TOOL = 'tools/call';

    function makeQueryServer(maxQueryRows?: number) {
      const stateBox = { current: makeStableState() };
      const queryDataSource = vi.fn(
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
          rows: [],
          rowCount: 0,
        }),
      );
      const server = buildStudioMcpServer(stateBox, {
        data: { queryDataSource, ...(maxQueryRows !== undefined && { maxQueryRows }) },
      });
      return { server, queryDataSource };
    }

    it('defaults to 1000 when no limit arg and no maxQueryRows', async () => {
      const { server, queryDataSource } = makeQueryServer();
      await getHandler(
        server,
        CALL_TOOL,
      )({
        params: { name: 'query_data_source', arguments: { sourceId: 'source-orders' } },
        method: CALL_TOOL,
      });
      expect(queryDataSource).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
    });

    it('clamps model-supplied limit to maxQueryRows', async () => {
      const { server, queryDataSource } = makeQueryServer(100);
      await getHandler(
        server,
        CALL_TOOL,
      )({
        params: {
          name: 'query_data_source',
          arguments: { sourceId: 'source-orders', limit: 9999 },
        },
        method: CALL_TOOL,
      });
      expect(queryDataSource).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('respects a lower model-supplied limit when within maxQueryRows', async () => {
      const { server, queryDataSource } = makeQueryServer(500);
      await getHandler(
        server,
        CALL_TOOL,
      )({
        params: { name: 'query_data_source', arguments: { sourceId: 'source-orders', limit: 50 } },
        method: CALL_TOOL,
      });
      expect(queryDataSource).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });
  });

  describe('prompts/list + prompts/get', () => {
    const LIST_PROMPTS = 'prompts/list';
    const GET_PROMPT = 'prompts/get';

    it('lists query_data_source_examples prompt', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(server, LIST_PROMPTS)({ params: {}, method: LIST_PROMPTS });
      const prompts = (result as any).prompts as Array<{ name: string }>;
      expect(prompts.map((p) => p.name)).toContain('query_data_source_examples');
    });

    it('get query_data_source_examples returns assistant then user messages', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(
        server,
        GET_PROMPT,
      )({
        params: { name: 'query_data_source_examples' },
        method: GET_PROMPT,
      });
      const messages = (result as any).messages as Array<{
        role: string;
        content: { text: string };
      }>;
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content.text).toContain('source-orders');
      expect(messages[1].role).toBe('user');
    });

    it('get query_data_source_examples with sourceId filters to that source', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(
        server,
        GET_PROMPT,
      )({
        params: { name: 'query_data_source_examples', arguments: { sourceId: 'source-orders' } },
        method: GET_PROMPT,
      });
      const messages = (result as any).messages as Array<{
        role: string;
        content: { text: string };
      }>;
      expect(messages).toHaveLength(2);
      expect(messages[0].content.text).toContain('source-orders');
    });

    it('get query_data_source_examples throws for unknown sourceId', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      await expect(
        getHandler(
          server,
          GET_PROMPT,
        )({
          params: { name: 'query_data_source_examples', arguments: { sourceId: 'unknown-id' } },
          method: GET_PROMPT,
        }),
      ).rejects.toThrow(/Unknown sourceId/);
    });

    it('throws on unknown prompt name', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      await expect(
        getHandler(server, GET_PROMPT)({ params: { name: 'nonexistent' }, method: GET_PROMPT }),
      ).rejects.toThrow(/Unknown prompt/);
    });
  });

  describe('completion/complete — URI autocomplete', () => {
    const COMPLETE = 'completion/complete';

    it('returns sourceId completions for studio://schema/ prefix', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(
        server,
        COMPLETE,
      )({
        params: {
          ref: { type: 'ref/resource', uri: 'studio://schema/' },
          argument: { name: 'uri', value: 'studio://schema/' },
        },
        method: COMPLETE,
      });
      const values = (result as any).completion.values as string[];
      expect(values).toContain('studio://schema/source-orders');
    });

    it('filters completions by partial sourceId', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(
        server,
        COMPLETE,
      )({
        params: {
          ref: { type: 'ref/resource', uri: 'studio://schema/source-ord' },
          argument: { name: 'uri', value: 'studio://schema/source-ord' },
        },
        method: COMPLETE,
      });
      const values = (result as any).completion.values as string[];
      expect(values).toContain('studio://schema/source-orders');
    });

    it('returns data completions for studio://data/ prefix when source has tableName', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(
        server,
        COMPLETE,
      )({
        params: {
          ref: { type: 'ref/resource', uri: 'studio://data/' },
          argument: { name: 'uri', value: 'studio://data/' },
        },
        method: COMPLETE,
      });
      const values = (result as any).completion.values as string[];
      expect(values).toContain('studio://data/source-orders');
    });

    it('returns empty values for unknown URI prefix', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(
        server,
        COMPLETE,
      )({
        params: {
          ref: { type: 'ref/resource', uri: 'studio://unknown/' },
          argument: { name: 'uri', value: 'studio://unknown/' },
        },
        method: COMPLETE,
      });
      const values = (result as any).completion.values as string[];
      expect(values).toHaveLength(0);
    });
  });

  describe('query_data_source tool — offset pagination', () => {
    const CALL_TOOL = 'tools/call';

    it('forwards offset to queryDataSource when supplied', async () => {
      const stateBox = { current: makeStableState() };
      const queryDataSource = vi.fn(
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
          rows: [],
          rowCount: 0,
        }),
      );
      const server = buildStudioMcpServer(stateBox, { data: { queryDataSource } });
      await getHandler(
        server,
        CALL_TOOL,
      )({
        params: {
          name: 'query_data_source',
          arguments: { sourceId: 'source-orders', limit: 10, offset: 20 },
        },
        method: CALL_TOOL,
      });
      expect(queryDataSource).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 20 }),
      );
    });

    it('does not forward offset when omitted', async () => {
      const stateBox = { current: makeStableState() };
      const queryDataSource = vi.fn(
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
          rows: [],
          rowCount: 0,
        }),
      );
      const server = buildStudioMcpServer(stateBox, { data: { queryDataSource } });
      await getHandler(
        server,
        CALL_TOOL,
      )({
        params: { name: 'query_data_source', arguments: { sourceId: 'source-orders' } },
        method: CALL_TOOL,
      });
      const call = queryDataSource.mock.calls[0][0] as StudioDataQueryParams;
      expect(call.offset).toBeUndefined();
    });
  });

  describe('onStateChange callback', () => {
    const CALL_TOOL = 'tools/call';

    it('fires after a mutating tool call with the new state', async () => {
      const stateBox = { current: makeStableState() };
      const onStateChange = vi.fn();
      const server = buildStudioMcpServer(stateBox, { onStateChange });
      await getHandler(
        server,
        CALL_TOOL,
      )({
        params: { name: 'add_page', arguments: { title: 'New Page' } },
        method: CALL_TOOL,
      });
      expect(onStateChange).toHaveBeenCalledOnce();
      const savedState = onStateChange.mock.calls[0][0];
      expect(
        Object.values(savedState.pages as Record<string, { title: string }>).some(
          (p) => p.title === 'New Page',
        ),
      ).toBe(true);
    });

    it('does not fire for read-only tool calls', async () => {
      const stateBox = { current: makeStableState() };
      const onStateChange = vi.fn();
      const server = buildStudioMcpServer(stateBox, { onStateChange });
      await getHandler(
        server,
        CALL_TOOL,
      )({
        params: { name: 'get_dashboard_state', arguments: {} },
        method: CALL_TOOL,
      });
      expect(onStateChange).not.toHaveBeenCalled();
    });
  });

  describe('summarise_page tool', () => {
    const CALL_TOOL = 'tools/call';
    const LIST_TOOLS = 'tools/list';

    it('is listed in tools/list', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = await getHandler(server, LIST_TOOLS)({ params: {}, method: LIST_TOOLS });
      const names = ((result as any).tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain('summarise_page');
    });

    it('returns a text summary when data is configured and page has widgets', async () => {
      const state = makeStableState();
      // Add a widget with sourceId to the page
      const widgetId = 'w-test';
      state.widgets[widgetId] = {
        id: widgetId,
        kind: 'grid',
        title: 'Orders Grid',
        sourceId: 'source-orders',
        config: {},
      } as any;
      state.pages[PAGE_ID] = {
        ...state.pages[PAGE_ID],
        widgetRows: [[widgetId]],
      };
      const stateBox = { current: state };
      const queryDataSource = vi.fn(
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
          rows: [{ id: 'o1', total: 100, status: 'pending' }],
          rowCount: 42,
        }),
      );
      const server = buildStudioMcpServer(stateBox, { data: { queryDataSource } });
      const result = (await getHandler(
        server,
        CALL_TOOL,
      )({
        params: { name: 'summarise_page', arguments: {} },
        method: CALL_TOOL,
      })) as any;
      const text = result.content[0].text as string;
      expect(text).toContain('Orders Grid');
      expect(text).toContain('42');
    });

    it('returns descriptive error when data is not configured', async () => {
      const stateBox = { current: makeStableState() };
      const server = buildStudioMcpServer(stateBox);
      const result = (await getHandler(
        server,
        CALL_TOOL,
      )({
        params: { name: 'summarise_page', arguments: {} },
        method: CALL_TOOL,
      })) as any;
      // Not isError — the tool returns a helpful message, not an exception
      const text = result.content[0].text as string;
      expect(text).toContain('client-side');
    });

    it('runs anomaly detection via GROUP BY query for time-series charts', async () => {
      const state = makeStableState();
      state.dataSources['source-orders'] = makeSource({
        fields: [
          ...(makeSource().fields ?? []),
          { id: 'order_date', label: 'Order Date', type: 'date' } as any,
        ],
      });
      const widgetId = 'w-chart';
      state.widgets[widgetId] = {
        id: widgetId,
        kind: 'chart',
        title: 'Monthly Revenue',
        sourceId: 'source-orders',
        config: {
          chartType: 'bar',
          xField: 'order_date',
          yField: 'total',
          xGroupBy: 'month',
          yAggregation: 'sum',
        },
      } as any;
      state.pages[PAGE_ID] = { ...state.pages[PAGE_ID], widgetRows: [[widgetId]] };

      const queryDataSource = vi.fn(
        async (params: StudioDataQueryParams): Promise<StudioDataQueryResult> => {
          if (params.aggregations?.length) {
            // GROUP BY query — return 12 monthly rows with one clear anomaly in August
            return {
              rows: [
                { order_date: '2024-01-01', y_agg: 100 },
                { order_date: '2024-02-01', y_agg: 102 },
                { order_date: '2024-03-01', y_agg: 98 },
                { order_date: '2024-04-01', y_agg: 103 },
                { order_date: '2024-05-01', y_agg: 99 },
                { order_date: '2024-06-01', y_agg: 101 },
                { order_date: '2024-07-01', y_agg: 100 },
                { order_date: '2024-08-01', y_agg: 500 },
                { order_date: '2024-09-01', y_agg: 102 },
                { order_date: '2024-10-01', y_agg: 98 },
                { order_date: '2024-11-01', y_agg: 101 },
                { order_date: '2024-12-01', y_agg: 100 },
              ],
              rowCount: 12,
            };
          }
          return { rows: [{ id: 'o1', total: 100, status: 'pending' }], rowCount: 365 };
        },
      );
      const server = buildStudioMcpServer({ current: state }, { data: { queryDataSource } });
      const result = (await getHandler(
        server,
        CALL_TOOL,
      )({
        params: { name: 'summarise_page', arguments: {} },
        method: CALL_TOOL,
      })) as any;
      const text = result.content[0].text as string;
      expect(text).toContain('Anomalies detected at: 2024-08');
      // No noise when no anomalies — check no "No anomalies detected." line
      expect(text).not.toContain('No anomalies detected');
      // GROUP BY query was issued
      const aggCall = queryDataSource.mock.calls.find(([p]) => p.aggregations?.length);
      expect(aggCall).toBeDefined();
      expect(aggCall![0]).toMatchObject({
        columns: ['order_date'],
        aggregations: [{ column: 'total', func: 'sum', alias: 'y_agg' }],
      });
    });

    it('skips anomaly detection for blended charts', async () => {
      const state = makeStableState();
      const widgetId = 'w-blended';
      state.widgets[widgetId] = {
        id: widgetId,
        kind: 'chart',
        title: 'Blended Chart',
        sourceId: 'source-orders',
        config: {
          chartType: 'bar',
          xField: 'order_date',
          xGroupBy: 'month',
          ySeries: [{ fieldId: 'revenue', sourceId: 'other-source' }],
        },
      } as any;
      state.pages[PAGE_ID] = { ...state.pages[PAGE_ID], widgetRows: [[widgetId]] };

      const queryDataSource = vi.fn(
        async (_p: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
          rows: [{ id: 'o1', total: 100 }],
          rowCount: 1,
        }),
      );
      const server = buildStudioMcpServer({ current: state }, { data: { queryDataSource } });
      await getHandler(
        server,
        CALL_TOOL,
      )({
        params: { name: 'summarise_page', arguments: {} },
        method: CALL_TOOL,
      });
      // Only the raw-rows query should fire — no GROUP BY call
      const aggCall = queryDataSource.mock.calls.find(([p]) => p.aggregations?.length);
      expect(aggCall).toBeUndefined();
    });
  });
});

describe('buildStudioMcpServer — context for MCP clients', () => {
  const LIST_TOOLS = 'tools/list';
  const CALL_TOOL = 'tools/call';

  it('lists the get_recent_changes tool', async () => {
    const server = buildStudioMcpServer({ current: makeStableState() });
    const result = await getHandler(server, LIST_TOOLS)({ params: {}, method: LIST_TOOLS });
    const names = ((result as any).tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('get_recent_changes');
  });

  it('records mutations and returns them via get_recent_changes (oldest first)', async () => {
    const server = buildStudioMcpServer({ current: makeStableState() });
    const call = getHandler(server, CALL_TOOL);
    await call({
      params: { name: 'set_dashboard_title', arguments: { title: 'New Title' } },
      method: CALL_TOOL,
    });
    await call({ params: { name: 'add_page', arguments: { title: 'Page 2' } }, method: CALL_TOOL });

    const result = (await call({
      params: { name: 'get_recent_changes', arguments: {} },
      method: CALL_TOOL,
    })) as any;
    const { output } = JSON.parse(result.content[0].text);
    expect(output).toHaveLength(2);
    expect(output[0].label).toBe('setDashboardTitle');
    expect(output[1].label).toMatch(/^addPage:/);
    expect(Number.isNaN(Date.parse(output[0].at))).toBe(false);
  });

  it('includes the distilled cross-filter graph in the system-prompt resource', async () => {
    const state = makeStableState();
    state.widgets.w1 = {
      id: 'w1',
      kind: 'chart',
      title: 'Orders',
      sourceId: 'source-orders',
      config: { chartType: 'bar' },
    } as any;
    state.pages[PAGE_ID] = { ...state.pages[PAGE_ID], widgetRows: [['w1']] };
    state.filters = [
      {
        id: 'xf',
        field: 'status',
        operator: 'equals',
        value: 'pending',
        scope: 'cross-filter',
        sourceWidgetId: 'w1',
        pageId: PAGE_ID,
      } as any,
    ];
    const server = buildStudioMcpServer({ current: state });
    const result = (await getHandler(server, READ_RESOURCE)({
      params: { uri: 'studio://dashboard/system-prompt' },
      method: READ_RESOURCE,
    })) as any;
    const text = result.contents[0].text as string;
    expect(text).toContain('<dashboard_context>');
    expect(text).toContain('filters by `status` (cross-filter)');
  });

  it('renders contextEnricher output into the system-prompt resource', async () => {
    const contextEnricher = vi.fn().mockResolvedValue({ notes: 'Enriched server-side.' });
    const server = buildStudioMcpServer({ current: makeStableState() }, { contextEnricher });
    const result = (await getHandler(server, READ_RESOURCE)({
      params: { uri: 'studio://dashboard/system-prompt' },
      method: READ_RESOURCE,
    })) as any;
    const text = result.contents[0].text as string;
    expect(contextEnricher).toHaveBeenCalledOnce();
    expect(text).toContain('<server_context>');
    expect(text).toContain('Enriched server-side.');
  });

  it('still returns the system prompt when contextEnricher throws', async () => {
    const contextEnricher = vi.fn().mockRejectedValue(new Error('boom'));
    const errorLog = vi.fn();
    const server = buildStudioMcpServer(
      { current: makeStableState() },
      { contextEnricher, logger: { log: vi.fn(), error: errorLog } },
    );
    const result = (await getHandler(server, READ_RESOURCE)({
      params: { uri: 'studio://dashboard/system-prompt' },
      method: READ_RESOURCE,
    })) as any;
    const text = result.contents[0].text as string;
    expect(text).not.toContain('<server_context>');
    expect(errorLog).toHaveBeenCalled();
  });
});
