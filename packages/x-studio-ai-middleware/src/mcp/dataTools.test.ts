/**
 * Unit tests for `mcp/dataTools.ts`'s handler factories, exercised directly
 * (rather than through the full `buildStudioMcpServer` composition root).
 *
 * Covers the gap flagged by the architecture review (T4-1): the query handlers
 * (`describe_data_source`, `get_field_values`, `compute_field_stats`,
 * `render_chart`) previously had zero direct tests anywhere in the package.
 */

import { describe, expect, it, vi } from 'vitest';
import { createDataToolHandlers, createSummarisePageHandler, resolveSource } from './dataTools';
import type { DataToolDeps } from './dataTools';
import { EXTRA_TOOL_DEFINITIONS } from './toolMetadata';
import { renderChartSvg } from '../chartRenderer';
import { createDefaultStudioState } from '../models/studioTypes';
import type { StudioDataSource, StudioState } from '../models/studioTypes';
import type { StudioDataQueryParams, StudioDataQueryResult } from './types';

const PAGE_ID = 'page-1';

function makeSource(overrides?: Partial<StudioDataSource>): StudioDataSource {
  return {
    id: 'source-orders',
    label: 'Orders',
    tableName: 'orders',
    fields: [
      { id: 'id', label: 'Order ID', type: 'string' },
      { id: 'total', label: 'Total', type: 'number', defaultAggregationFn: 'sum' },
      { id: 'quantity', label: 'Quantity', type: 'number', defaultAggregationFn: 'sum' },
      { id: 'status', label: 'Status', type: 'string' },
    ],
    ...overrides,
  } as StudioDataSource;
}

/**
 * Test-local convenience shape: a flat bag mirroring the pre-partition test
 * fixtures (`dataSources` is a runtime-partition field) so call sites below did
 * not need to change. Private to this test file — not a production shape.
 */
interface MakeStateOverrides {
  dataSources?: Record<string, StudioDataSource>;
}

function makeState(overrides?: MakeStateOverrides): StudioState {
  return createDefaultStudioState({
    doc: {
      dashboard: { id: 'd1', title: 'Test', activePageId: PAGE_ID },
      pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [] } },
    },
    runtime: {
      dataSources: overrides?.dataSources ?? { 'source-orders': makeSource() },
    },
  });
}

function makeDeps(overrides?: Partial<DataToolDeps>): DataToolDeps {
  return {
    stateBox: { current: makeState() },
    maxQueryRows: 1000,
    recentChanges: [],
    ...overrides,
  };
}

async function readText(result: any): Promise<string> {
  return result.content[0].text as string;
}

describe('createDataToolHandlers', () => {
  describe('query_data_source', () => {
    it('returns an error when data access is not configured', async () => {
      const handlers = createDataToolHandlers(makeDeps());
      const result: any = await handlers.query_data_source({ sourceId: 'source-orders' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(await readText(result)).error).toMatch(/not available/i);
    });

    it('requires a sourceId', async () => {
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource: vi.fn() } }));
      const result: any = await handlers.query_data_source({});
      expect(result.isError).toBe(true);
      expect(JSON.parse(await readText(result)).error).toMatch(/sourceId is required/);
    });

    it('returns a descriptive error for an unknown sourceId (never queries a phantom table)', async () => {
      // Regression guard: an unknown/unregistered sourceId must be rejected up front
      // with the same descriptive error the sibling handlers return — it must NOT be
      // forwarded to queryDataSource as a physical table name (which would surface a
      // raw DB error, or query an unintended table).
      const queryDataSource = vi.fn();
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
      const result: any = await handlers.query_data_source({ sourceId: 'not-a-real-source' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(await readText(result)).error).toMatch(/Unknown data source/);
      // The unified, transport-neutral hint (no `studio://` resource URI — this
      // handler is also reached via the chat transport's agentic loop, where a
      // resource URI means nothing).
      expect(JSON.parse(await readText(result)).error).toMatch(/get_dashboard_state/);
      // The query was never dispatched against the bogus table name.
      expect(queryDataSource).not.toHaveBeenCalled();
    });

    it('resolves the physical table name and forwards the structured query for a known source', async () => {
      const queryDataSource = vi.fn(
        async (_params: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
          rows: [{ id: 'o1', total: 100 }],
          rowCount: 1,
        }),
      );
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
      const result: any = await handlers.query_data_source({
        sourceId: 'source-orders',
        columns: ['id', 'total'],
      });
      expect(result.isError).toBeFalsy();
      expect(queryDataSource).toHaveBeenCalledTimes(1);
      expect(queryDataSource.mock.calls[0][0]).toMatchObject({
        sourceId: 'source-orders',
        tableName: 'orders',
        columns: ['id', 'total'],
      });
    });

    // Regression for T2-6: `limit` was clamped on the upper bound only
    // (`Math.min(limit ?? maxQueryRows, maxQueryRows)`), so a negative or NaN
    // `limit` — and any `offset` at all — passed straight through to the host.
    describe('limit/offset clamping (T2-6)', () => {
      it('clamps a negative limit instead of forwarding it untouched', async () => {
        const queryDataSource = vi.fn(
          async (_params: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
            rows: [],
            rowCount: 0,
          }),
        );
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.query_data_source({ sourceId: 'source-orders', limit: -5 });
        const forwardedLimit = queryDataSource.mock.calls[0][0].limit;
        expect(forwardedLimit).not.toBeLessThan(0);
        expect(Number.isFinite(forwardedLimit)).toBe(true);
      });

      it('clamps a NaN-producing limit (e.g. a non-numeric string) instead of forwarding NaN', async () => {
        const queryDataSource = vi.fn(
          async (_params: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
            rows: [],
            rowCount: 0,
          }),
        );
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.query_data_source({ sourceId: 'source-orders', limit: 'all' as any });
        const forwardedLimit = queryDataSource.mock.calls[0][0].limit;
        expect(Number.isFinite(forwardedLimit)).toBe(true);
        expect(forwardedLimit).toBe(1000); // falls back to maxQueryRows
      });

      it('still respects the upper bound for an excessively large limit', async () => {
        const queryDataSource = vi.fn(
          async (_params: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
            rows: [],
            rowCount: 0,
          }),
        );
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.query_data_source({ sourceId: 'source-orders', limit: 1_000_000 });
        expect(queryDataSource.mock.calls[0][0].limit).toBe(1000);
      });

      it('coerces a negative offset to 0 instead of forwarding it untouched', async () => {
        const queryDataSource = vi.fn(
          async (_params: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
            rows: [],
            rowCount: 0,
          }),
        );
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.query_data_source({ sourceId: 'source-orders', offset: -10 });
        expect(queryDataSource.mock.calls[0][0].offset).toBe(0);
      });

      it('coerces a NaN-producing offset to 0', async () => {
        const queryDataSource = vi.fn(
          async (_params: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
            rows: [],
            rowCount: 0,
          }),
        );
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.query_data_source({ sourceId: 'source-orders', offset: 'many' as any });
        expect(queryDataSource.mock.calls[0][0].offset).toBe(0);
      });

      it('does not forward an offset key at all when offset is omitted', async () => {
        const queryDataSource = vi.fn(
          async (_params: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
            rows: [],
            rowCount: 0,
          }),
        );
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.query_data_source({ sourceId: 'source-orders' });
        expect('offset' in queryDataSource.mock.calls[0][0]).toBe(false);
      });

      it('forwards a valid positive integer offset unchanged', async () => {
        const queryDataSource = vi.fn(
          async (_params: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
            rows: [],
            rowCount: 0,
          }),
        );
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.query_data_source({ sourceId: 'source-orders', offset: 20 });
        expect(queryDataSource.mock.calls[0][0].offset).toBe(20);
      });
    });
  });

  describe('describe_data_source', () => {
    it('returns an error when data access is not configured', async () => {
      const handlers = createDataToolHandlers(makeDeps());
      const result: any = await handlers.describe_data_source({ sourceId: 'source-orders' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(await readText(result)).error).toMatch(/not configured/i);
    });

    it('returns an error for an unknown sourceId', async () => {
      const queryDataSource = vi.fn();
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
      const result: any = await handlers.describe_data_source({ sourceId: 'nope' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(await readText(result)).error).toMatch(/Unknown data source/);
      expect(JSON.parse(await readText(result)).error).toMatch(/get_dashboard_state/);
      expect(queryDataSource).not.toHaveBeenCalled();
    });

    it('aligns per-field stats positionally with numeric fields (Promise.all ordering)', async () => {
      // Two numeric fields (`total`, `quantity`) each get their own aggregation
      // query, resolved via `Promise.all` and re-associated with `numericFields[i]`
      // by array index. This test gives each field distinguishable stats and
      // deliberately resolves them out of call order, so a regression that
      // swaps/misaligns the two would fail the field-specific assertions below.
      let callIndex = 0;
      const queryDataSource = vi.fn(async (params: StudioDataQueryParams) => {
        const thisCall = callIndex;
        callIndex += 1;
        if (params.aggregations?.length) {
          const field = params.aggregations[0].column;
          // Resolve the *first* aggregation call after the second one, to
          // simulate out-of-order completion.
          if (thisCall === 1) {
            await new Promise((resolve) => {
              setTimeout(resolve, 5);
            });
          }
          if (field === 'total') {
            return { rows: [{ min: 10, max: 1000, avg: 123.456, sum: 5000 }], rowCount: 1 };
          }
          return { rows: [{ min: 1, max: 20, avg: 3.5, sum: 200 }], rowCount: 1 };
        }
        return { rows: [{ id: 'o1', total: 100, quantity: 2, status: 'pending' }], rowCount: 42 };
      });
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
      const result: any = await handlers.describe_data_source({ sourceId: 'source-orders' });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(await readText(result));
      const totalField = parsed.fields.find((f: any) => f.id === 'total');
      const quantityField = parsed.fields.find((f: any) => f.id === 'quantity');
      expect(totalField.stats).toEqual({ min: 10, max: 1000, avg: 123.46, sum: 5000 });
      expect(quantityField.stats).toEqual({ min: 1, max: 20, avg: 3.5, sum: 200 });
      expect(parsed.rowCount).toBe(42);
      expect(parsed.sourceId).toBe('source-orders');
    });

    it('omits stats for a field whose aggregation query rejects', async () => {
      const queryDataSource = vi.fn(async (params: StudioDataQueryParams) => {
        if (params.aggregations?.length && params.aggregations[0].column === 'total') {
          throw new Error('db error');
        }
        if (params.aggregations?.length) {
          return { rows: [{ min: 1, max: 20, avg: 3.5, sum: 200 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
      const result: any = await handlers.describe_data_source({ sourceId: 'source-orders' });
      const parsed = JSON.parse(await readText(result));
      const totalField = parsed.fields.find((f: any) => f.id === 'total');
      const quantityField = parsed.fields.find((f: any) => f.id === 'quantity');
      expect(totalField.stats).toBeUndefined();
      expect(quantityField.stats).toBeDefined();
    });
  });

  describe('get_field_values', () => {
    it('requires sourceId and fieldId', async () => {
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource: vi.fn() } }));
      const result: any = await handlers.get_field_values({ sourceId: 'source-orders' });
      expect(result.isError).toBe(true);
    });

    it('does not auto-render a chart when fewer than 2 datapoints are returned', async () => {
      const queryDataSource = vi.fn(
        async (): Promise<StudioDataQueryResult> => ({
          rows: [{ status: 'pending', count: 5 }],
          rowCount: 1,
        }),
      );
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
      const result: any = await handlers.get_field_values({
        sourceId: 'source-orders',
        fieldId: 'status',
      });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });

    it('auto-renders a bar chart when >= 2 datapoints are returned', async () => {
      const queryDataSource = vi.fn(
        async (): Promise<StudioDataQueryResult> => ({
          rows: [
            { status: 'pending', count: 5 },
            { status: 'shipped', count: 3 },
          ],
          rowCount: 2,
        }),
      );
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
      const result: any = await handlers.get_field_values({
        sourceId: 'source-orders',
        fieldId: 'status',
      });
      expect(result.content).toHaveLength(2);
      expect(result.content[0].type).toBe('text');
      expect(result.content[1].type).toBe('image');
      expect(result.content[1].mimeType).toBe('image/svg+xml');
    });

    it('returns an error for an unknown source', async () => {
      const queryDataSource = vi.fn();
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
      const result: any = await handlers.get_field_values({ sourceId: 'nope', fieldId: 'status' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(await readText(result)).error).toMatch(/Unknown data source/);
      expect(JSON.parse(await readText(result)).error).toMatch(/get_dashboard_state/);
      expect(queryDataSource).not.toHaveBeenCalled();
    });

    // Regression for T2-1: `limit` was clamped on the upper bound only
    // (`Math.min(fieldLimit ?? 50, 200)`), so a NaN/negative/zero/fractional
    // value reached the host's `queryDataSource` unclamped (e.g. `LIMIT NaN`),
    // mirroring the T2-6 gap already fixed for `query_data_source`.
    describe('limit clamping (T2-1)', () => {
      const emptyQuery = () =>
        vi.fn(
          async (_params: StudioDataQueryParams): Promise<StudioDataQueryResult> => ({
            rows: [],
            rowCount: 0,
          }),
        );

      it('clamps a NaN-producing limit (non-numeric string) to the default instead of forwarding NaN', async () => {
        const queryDataSource = emptyQuery();
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.get_field_values({
          sourceId: 'source-orders',
          fieldId: 'status',
          limit: 'many' as any,
        });
        const forwarded = queryDataSource.mock.calls[0][0].limit;
        expect(Number.isFinite(forwarded)).toBe(true);
        expect(forwarded).toBe(50);
      });

      it('coerces a negative limit to a positive value instead of forwarding it untouched', async () => {
        const queryDataSource = emptyQuery();
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.get_field_values({
          sourceId: 'source-orders',
          fieldId: 'status',
          limit: -3,
        });
        const forwarded = queryDataSource.mock.calls[0][0].limit;
        expect(forwarded).toBeGreaterThanOrEqual(1);
      });

      it('replaces a zero limit with the default instead of forwarding LIMIT 0', async () => {
        const queryDataSource = emptyQuery();
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.get_field_values({ sourceId: 'source-orders', fieldId: 'status', limit: 0 });
        expect(queryDataSource.mock.calls[0][0].limit).toBe(50);
      });

      it('truncates a fractional limit to an integer', async () => {
        const queryDataSource = emptyQuery();
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.get_field_values({
          sourceId: 'source-orders',
          fieldId: 'status',
          limit: 25.9,
        });
        expect(queryDataSource.mock.calls[0][0].limit).toBe(25);
      });

      it('still enforces the upper bound of 200 for an excessively large limit', async () => {
        const queryDataSource = emptyQuery();
        const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
        await handlers.get_field_values({
          sourceId: 'source-orders',
          fieldId: 'status',
          limit: 5000,
        });
        expect(queryDataSource.mock.calls[0][0].limit).toBe(200);
      });
    });
  });

  describe('compute_field_stats', () => {
    it('requires sourceId and a non-empty fields array', async () => {
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource: vi.fn() } }));
      const result: any = await handlers.compute_field_stats({
        sourceId: 'source-orders',
        fields: [],
      });
      expect(result.isError).toBe(true);
    });

    it('returns a descriptive error for an unknown sourceId (never queries a phantom table)', async () => {
      // Regression guard, matching the equivalent test for query_data_source:
      // compute_field_stats previously had NO hint pointing at a discovery path
      // for an unknown sourceId — it now shares the unified `resolveSource`
      // message with the other three data-query handlers.
      const queryDataSource = vi.fn();
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
      const result: any = await handlers.compute_field_stats({
        sourceId: 'not-a-real-source',
        fields: ['total'],
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(await readText(result)).error).toMatch(/Unknown data source/);
      expect(JSON.parse(await readText(result)).error).toMatch(/get_dashboard_state/);
      expect(queryDataSource).not.toHaveBeenCalled();
    });

    it('shapes min/max/avg/sum/count per requested field', async () => {
      const queryDataSource = vi.fn(
        async (): Promise<StudioDataQueryResult> => ({
          rows: [
            {
              total__min: 10,
              total__max: 1000,
              total__avg: 55.5555,
              total__sum: 5000,
              total__count: 90,
            },
          ],
          rowCount: 1,
        }),
      );
      const handlers = createDataToolHandlers(makeDeps({ data: { queryDataSource } }));
      const result: any = await handlers.compute_field_stats({
        sourceId: 'source-orders',
        fields: ['total'],
      });
      const parsed = JSON.parse(await readText(result));
      expect(parsed.stats.total).toEqual({ min: 10, max: 1000, avg: 55.56, sum: 5000, count: 90 });
    });
  });

  describe('render_chart', () => {
    it('requires a `type`', () => {
      const handlers = createDataToolHandlers(makeDeps());
      const view: any = handlers.render_chart({});
      expect(view.isError).toBe(true);
    });

    it('renders an SVG bar chart as base64 image + text content', () => {
      const handlers = createDataToolHandlers(makeDeps());
      const view: any = handlers.render_chart({
        type: 'bar',
        data: [
          { label: 'A', value: 1 },
          { label: 'B', value: 2 },
        ],
      });
      expect(view.content).toHaveLength(2);
      expect(view.content[0].type).toBe('image');
      expect(view.content[0].mimeType).toBe('image/svg+xml');
      expect(view.content[1].type).toBe('text');
      expect(view.content[1].text).toContain('<svg');
    });

    // Regression for T2-4: the render_chart description advertised a scatter mode
    // ("two series where series[0] = x-values and series[1] = y-values") that
    // `renderScatter` never implemented — calling it that way yields a wrong chart
    // (both series plotted as y against xLabels) or, with no xLabels, an empty
    // placeholder. The description was corrected to match the real behavior.
    describe('render_chart scatter description matches renderScatter (T2-4)', () => {
      const renderChartDef = EXTRA_TOOL_DEFINITIONS.find((d) => d.name === 'render_chart');

      it('no longer advertises the unimplemented series[0]=x / series[1]=y scatter mode', () => {
        expect(renderChartDef).toBeDefined();
        const description = renderChartDef!.description;
        expect(description).not.toMatch(/series\[0\]/);
        expect(description).not.toMatch(/series\[1\]/);
      });

      it('two series without xLabels produce the placeholder, confirming the removed claim was false', () => {
        // The advertised mode said this would zip series[0]/series[1] as x/y. It does
        // not: with two series and no xLabels the scatter branch is skipped, `data` is
        // absent, and no points are produced.
        const view = renderChartSvg({
          type: 'scatter',
          series: [
            { name: 'x', values: [1, 2, 3] },
            { name: 'y', values: [10, 20, 30] },
          ],
        });
        expect(view).toContain('No data provided');
      });
    });
  });

  describe('get_recent_changes', () => {
    it('returns the injected recentChanges log', () => {
      const recentChanges = [{ label: 'addPage:Page 2', at: new Date().toISOString() }] as any;
      const handlers = createDataToolHandlers(makeDeps({ recentChanges }));
      const result: any = handlers.get_recent_changes(undefined);
      const parsed = JSON.parse(result.content[0].text);
      // Returned directly, with no `{ output }` envelope.
      expect(parsed).toEqual(recentChanges);
    });
  });
});

describe('resolveSource', () => {
  // Pins the single unified message all four data-query handlers now share
  // (query_data_source, describe_data_source, get_field_values,
  // compute_field_stats), guarding against the four messages drifting apart
  // from each other again.
  it('returns an ok:false result with the unified, transport-neutral message for an unknown sourceId', () => {
    const stateBox = { current: makeState() };
    const result = resolveSource(stateBox, 'not-a-real-source');
    expect(result.ok).toBe(false);
    const errorResult = result as Extract<typeof result, { ok: false }>;
    expect(errorResult.error.isError).toBe(true);
    const message = JSON.parse((errorResult.error.content[0] as { text: string }).text).error;
    expect(message).toMatch(/Unknown data source: "not-a-real-source"/);
    expect(message).toMatch(/get_dashboard_state/);
    expect(message).toMatch(/studio:\/\/dashboard\/state/);
  });

  it('returns an ok:true result with the resolved source and tableName for a known sourceId', () => {
    const stateBox = { current: makeState() };
    const result = resolveSource(stateBox, 'source-orders');
    expect(result.ok).toBe(true);
    const okResult = result as Extract<typeof result, { ok: true }>;
    expect(okResult.tableName).toBe('orders');
    expect(okResult.source.id).toBe('source-orders');
  });

  it('treats a registered source with no tableName as unknown', () => {
    const stateBox = {
      current: makeState({
        dataSources: { 'source-orders': makeSource({ tableName: undefined }) },
      }),
    };
    const result = resolveSource(stateBox, 'source-orders');
    expect(result.ok).toBe(false);
  });
});

describe('createSummarisePageHandler', () => {
  it('preserves page/layout order regardless of query-completion order', async () => {
    // Three widgets on the same row; make the *first* widget's query resolve
    // *last* so a regression back to "push on completion" would reorder the
    // sections by latency instead of by `widgetRows` order.
    const state = makeState();
    state.doc.widgets['w-1'] = {
      id: 'w-1',
      kind: 'grid',
      title: 'First',
      sourceId: 'source-orders',
      config: {},
    } as any;
    state.doc.widgets['w-2'] = {
      id: 'w-2',
      kind: 'grid',
      title: 'Second',
      sourceId: 'source-orders',
      config: {},
    } as any;
    state.doc.widgets['w-3'] = {
      id: 'w-3',
      kind: 'grid',
      title: 'Third',
      sourceId: 'source-orders',
      config: {},
    } as any;
    state.doc.pages[PAGE_ID] = { ...state.doc.pages[PAGE_ID], widgetRows: [['w-1', 'w-2', 'w-3']] };

    const queryDataSource = vi.fn(async (): Promise<StudioDataQueryResult> => {
      // Widget 'w-1' is queried first (per widgetRows order) but delayed the most.
      if (queryDataSource.mock.calls.length === 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      return { rows: [{ id: 'o1', total: 100, status: 'pending' }], rowCount: 1 };
    });

    const handler = createSummarisePageHandler({
      stateBox: { current: state },
      data: { queryDataSource },
    });
    const result: any = await handler({});
    const text = result.content[0].text as string;
    const firstIdx = text.indexOf('First');
    const secondIdx = text.indexOf('Second');
    const thirdIdx = text.indexOf('Third');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });

  it('skips the anomaly path for avg/min/max yAggregation (no bogus summed bucket)', async () => {
    const state = makeState({
      dataSources: {
        'source-orders': makeSource({
          fields: [
            ...(makeSource().fields ?? []),
            { id: 'order_date', label: 'Order Date', type: 'date' } as any,
          ],
        }),
      },
    });
    state.doc.widgets['w-chart'] = {
      id: 'w-chart',
      kind: 'chart',
      title: 'Avg Order Value',
      sourceId: 'source-orders',
      config: {
        chartType: 'bar',
        xField: 'order_date',
        yField: 'total',
        xGroupBy: 'month',
        yAggregation: 'avg',
      },
    } as any;
    state.doc.pages[PAGE_ID] = { ...state.doc.pages[PAGE_ID], widgetRows: [['w-chart']] };

    const queryDataSource = vi.fn(async (params: StudioDataQueryParams) => {
      if (params.aggregations?.length) {
        throw new Error('the aggregation (GROUP BY) query should not run for avg yAggregation');
      }
      return { rows: [{ id: 'o1', total: 100 }], rowCount: 1 };
    });
    const handler = createSummarisePageHandler({
      stateBox: { current: state },
      data: { queryDataSource },
    });
    const result: any = await handler({});
    const text = result.content[0].text as string;
    expect(text).not.toContain('Anomalies detected');
    expect(queryDataSource.mock.calls.some(([p]) => p.aggregations?.length)).toBe(false);
  });

  it('still runs the anomaly path for sum yAggregation', async () => {
    const state = makeState({
      dataSources: {
        'source-orders': makeSource({
          fields: [
            ...(makeSource().fields ?? []),
            { id: 'order_date', label: 'Order Date', type: 'date' } as any,
          ],
        }),
      },
    });
    state.doc.widgets['w-chart'] = {
      id: 'w-chart',
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
    state.doc.pages[PAGE_ID] = { ...state.doc.pages[PAGE_ID], widgetRows: [['w-chart']] };

    const queryDataSource = vi.fn(async (params: StudioDataQueryParams) => {
      if (params.aggregations?.length) {
        return {
          rows: [
            { order_date: '2024-01-01', y_agg: 100 },
            { order_date: '2024-02-01', y_agg: 102 },
            { order_date: '2024-03-01', y_agg: 98 },
            { order_date: '2024-04-01', y_agg: 101 },
            { order_date: '2024-05-01', y_agg: 500 },
            { order_date: '2024-06-01', y_agg: 99 },
          ],
          rowCount: 6,
        };
      }
      return { rows: [{ id: 'o1', total: 100 }], rowCount: 1 };
    });
    const handler = createSummarisePageHandler({
      stateBox: { current: state },
      data: { queryDataSource },
    });
    const result: any = await handler({});
    const text = result.content[0].text as string;
    expect(text).toContain('Anomalies detected at: 2024-05');
  });
});
