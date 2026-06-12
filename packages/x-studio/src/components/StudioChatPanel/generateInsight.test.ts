import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  generateWidgetInsight,
  generateDashboardSummary,
  generateAnomalyExplanation,
} from './generateInsight';
import type { StudioAIConfig } from './studioBackendAdapter';
import type { StudioController } from '../../store/StudioController';
import type { StudioChartAnnotation } from '../../models/baseTypes';
import { createDefaultStudioState } from '../../models/stateTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

const AI_CONFIG: StudioAIConfig = {
  endpoint: 'https://api.example.com/api/ai',
};

function mockFetch(text: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    text: () => Promise.resolve('Error body'),
    json: () => Promise.resolve({ text }),
  });
}

function makeController(widgetId: string, overrides?: object): StudioController {
  const PAGE_ID = 'page-1';
  const state = createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: PAGE_ID },
    pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [[widgetId]] } },
    widgets: {
      [widgetId]: {
        id: widgetId,
        kind: 'chart',
        title: 'Revenue Chart',
        sourceId: 'src1',
        config: { chartType: 'bar', xField: 'month', yField: 'revenue' },
        ...overrides,
      },
    },
    dataSources: {
      src1: {
        id: 'src1',
        label: 'Sales',
        fields: [
          { id: 'month', label: 'Month', type: 'string' },
          { id: 'revenue', label: 'Revenue', type: 'number' },
        ],
      },
    },
  });
  return { getState: () => state } as unknown as StudioController;
}

function makeControllerWithData(widgetId: string, overrides?: object): StudioController {
  const PAGE_ID = 'page-1';
  const state = createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: PAGE_ID },
    pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [[widgetId]] } },
    widgets: {
      [widgetId]: {
        id: widgetId,
        kind: 'chart',
        title: 'Revenue Chart',
        sourceId: 'src1',
        config: { chartType: 'bar', xField: 'month', yField: 'revenue' },
        ...overrides,
      },
    },
    dataSources: {
      src1: {
        id: 'src1',
        label: 'Sales',
        fields: [
          { id: 'month', label: 'Month', type: 'string' },
          { id: 'revenue', label: 'Revenue', type: 'number' },
        ],
        rows: [
          { month: 'Jan', revenue: 1000 },
          { month: 'Feb', revenue: 1200 },
          { month: 'Mar', revenue: 900 },
        ],
      },
    },
  });
  return { getState: () => state } as unknown as StudioController;
}

/**
 * Creates a controller with 150 rows so we can verify sampling strategies.
 * Rows are ordered: row-0..row-149 with revenues 0..149.
 */
function makeControllerWithLargeData(widgetId: string): StudioController {
  const PAGE_ID = 'page-1';
  const rows = Array.from({ length: 150 }, (_, i) => ({ month: `row-${i}`, revenue: i }));
  const state = createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: PAGE_ID },
    pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [[widgetId]] } },
    widgets: {
      [widgetId]: {
        id: widgetId,
        kind: 'chart',
        title: 'Revenue Chart',
        sourceId: 'src1',
        config: { chartType: 'line', xField: 'month', yField: 'revenue' },
      },
    },
    dataSources: {
      src1: {
        id: 'src1',
        label: 'Sales',
        fields: [
          { id: 'month', label: 'Month', type: 'string' },
          { id: 'revenue', label: 'Revenue', type: 'number' },
        ],
        rows,
      },
    },
  });
  return { getState: () => state } as unknown as StudioController;
}

/**
 * Controller with 4 rows and a revenue field marked aiAggregation='sum'.
 * Used to verify that the field hint overrides the 'avg' default.
 */
function makeControllerWithSumField(widgetId: string): StudioController {
  const PAGE_ID = 'page-1';
  const state = createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: PAGE_ID },
    pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [[widgetId]] } },
    widgets: {
      [widgetId]: {
        id: widgetId,
        kind: 'chart',
        title: 'Revenue Chart',
        sourceId: 'src1',
        config: { chartType: 'bar', xField: 'month', yField: 'revenue' },
      },
    },
    dataSources: {
      src1: {
        id: 'src1',
        label: 'Sales',
        fields: [
          { id: 'month', label: 'Month', type: 'string' },
          { id: 'revenue', label: 'Revenue', type: 'number', aiAggregation: 'sum' },
        ],
        // 4 rows — fewer than MAX_DATA_ROWS so no aggregation is triggered.
        // We'll use a small MAX by relying on the bucket logic: 4 rows, bucketSize=1
        // to force at least one bucket. Actually we just test via direct aggregation
        // with a dataset large enough to trigger bucketing.
        // Using 200 rows (> 100 MAX) so bucketSize=2 → sum per pair of rows.
        rows: Array.from({ length: 200 }, (_, i) => ({ month: `m-${i}`, revenue: 10 })),
      },
    },
  });
  return { getState: () => state } as unknown as StudioController;
}

// ── generateWidgetInsight ─────────────────────────────────────────────────────

describe('generateWidgetInsight', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch('Great insight text.'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the AI endpoint and returns the response text', async () => {
    const controller = makeController('w1');
    const result = await generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'summary' });
    expect(result.text).toBe('Great insight text.');
  });

  it('sends POST to the configured endpoint + /insight', async () => {
    const fetchMock = mockFetch('result');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController('w1');
    await generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'analysis' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${AI_CONFIG.endpoint}/insight`);
    expect(options.method).toBe('POST');
  });

  it('includes widget title in the request body', async () => {
    const fetchMock = mockFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController('w1');
    await generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'summary' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      widgetTitle: string;
    };
    expect(body.widgetTitle).toBe('Revenue Chart');
  });

  it('throws when the widget is not found', async () => {
    const controller = makeController('w1');
    await expect(
      generateWidgetInsight('nonexistent', controller, AI_CONFIG, { type: 'summary' }),
    ).rejects.toThrow('Widget "nonexistent" not found');
  });

  it('throws on non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', mockFetch('', 500));
    const controller = makeController('w1');
    await expect(
      generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'summary' }),
    ).rejects.toThrow('500');
  });

  it('aborts when signal is fired', async () => {
    const abortController = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, options: RequestInit) => {
        return new Promise((_, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }),
    );
    const controller = makeController('w1');
    const promise = generateWidgetInsight('w1', controller, AI_CONFIG, {
      type: 'summary',
      signal: abortController.signal,
    });
    abortController.abort();
    await expect(promise).rejects.toThrow('Aborted');
  });

  it('includes data sample in the request body when source has rows', async () => {
    const fetchMock = mockFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeControllerWithData('w1');
    await generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'forecast' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      dataSummary: string;
    };
    expect(body.dataSummary).toContain('Data sample');
    expect(body.dataSummary).toContain('Jan');
    expect(body.dataSummary).toContain('1000');
  });

  it('works without error when source has no rows', async () => {
    const fetchMock = mockFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController('w1'); // no rows
    await expect(
      generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'summary' }),
    ).resolves.toEqual({ text: 'ok' });
  });

  it('uses aggregate sampling for forecast — covers full range (first AND last bucket present)', async () => {
    const fetchMock = mockFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    // 150 rows → bucketSize=2 → 75 buckets; first month value of each bucket: row-0, row-2, ..., row-148
    const controller = makeControllerWithLargeData('w1');
    await generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'forecast' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      dataSummary: string;
    };
    expect(body.dataSummary).toContain('row-0'); // first bucket — full range coverage
    expect(body.dataSummary).toContain('row-148'); // last bucket
    expect(body.dataSummary).toContain('aggregated buckets'); // confirms aggregate mode
  });

  it('uses aggregate sampling for summary — covers full range with averaged values', async () => {
    const fetchMock = mockFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    // 150 rows → bucketSize=2 → 75 buckets; bucket 0 avg revenue = (0+1)/2 = 0.5
    const controller = makeControllerWithLargeData('w1');
    await generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'summary' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      dataSummary: string;
    };
    expect(body.dataSummary).toContain('row-0'); // first bucket present
    expect(body.dataSummary).toContain('row-148'); // last bucket present
    expect(body.dataSummary).toContain('aggregated buckets'); // confirms aggregate mode
    expect(body.dataSummary).toContain('0.5'); // first bucket avg revenue = (0+1)/2 = 0.5
  });

  it('includes stats preamble with min/max/avg for numeric fields', async () => {
    const fetchMock = mockFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeControllerWithData('w1');
    await generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'analysis' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      dataSummary: string;
    };
    // Stats from {1000, 1200, 900}: min=900, max=1200, avg=1033
    expect(body.dataSummary).toContain('Stats:');
    expect(body.dataSummary).toContain('min=900');
    expect(body.dataSummary).toContain('max=1200');
  });

  it('respects aiAggregation="sum" on field — bucket values are summed not averaged', async () => {
    const fetchMock = mockFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    // 200 rows, each revenue=10, bucketSize=2 → each bucket sum = 10+10 = 20
    const controller = makeControllerWithSumField('w1');
    await generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'summary' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      dataSummary: string;
    };
    expect(body.dataSummary).toContain('20'); // sum of bucket (10+10), not avg (10)
    expect(body.dataSummary).not.toContain(',10,'); // avg=10 would be present as a row value; sum=20 replaces it
  });
});

// ── generateDashboardSummary ──────────────────────────────────────────────────

describe('generateDashboardSummary', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch('Executive summary text.'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the AI response text', async () => {
    const controller = makeController('w1');
    const result = await generateDashboardSummary(controller, AI_CONFIG);
    expect(result.text).toBe('Executive summary text.');
  });

  it('includes widget title in the request body', async () => {
    const fetchMock = mockFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController('w1');
    await generateDashboardSummary(controller, AI_CONFIG);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      dataSummary: string;
    };
    expect(body.dataSummary).toContain('Revenue Chart');
  });
});

// ── generateAnomalyExplanation ────────────────────────────────────────────────

describe('generateAnomalyExplanation', () => {
  const anomalies: StudioChartAnnotation[] = [
    { id: 'a1', axis: 'x', value: 'August', label: '⚠' },
    { id: 'a2', axis: 'x', value: 'December', label: '⚠' },
  ];

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch('The spike in August was due to a promotional campaign.'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an explanation from the AI', async () => {
    const controller = makeController('w1');
    const result = await generateAnomalyExplanation('w1', anomalies, controller, AI_CONFIG);
    expect(result.text).toContain('August');
  });

  it('includes anomaly labels in the request body', async () => {
    const fetchMock = mockFetch('explanation');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController('w1');
    await generateAnomalyExplanation('w1', anomalies, controller, AI_CONFIG);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      dataSummary: string;
    };
    expect(body.dataSummary).toContain('August');
    expect(body.dataSummary).toContain('December');
  });

  it('throws when the widget is not found', async () => {
    const controller = makeController('w1');
    await expect(
      generateAnomalyExplanation('nonexistent', anomalies, controller, AI_CONFIG),
    ).rejects.toThrow('Widget "nonexistent" not found');
  });

  it('includes data sample in the anomaly body when source has rows', async () => {
    const fetchMock = mockFetch('explanation');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeControllerWithData('w1');
    await generateAnomalyExplanation('w1', anomalies, controller, AI_CONFIG);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      dataSummary: string;
    };
    expect(body.dataSummary).toContain('Data sample');
    expect(body.dataSummary).toContain('Jan');
    expect(body.dataSummary).toContain('1000');
  });

  it('guarantees anomaly rows are in the sample even if they fall outside the stride window', async () => {
    const fetchMock = mockFetch('explanation');
    vi.stubGlobal('fetch', fetchMock);
    // 150 rows: row-0..row-149. Stride-100 would include row-0, row-2, ..., row-148.
    // Anomaly is 'row-141' — an odd index, excluded by stride but must appear via anomaly path.
    const controller = makeControllerWithLargeData('w1');
    const lateAnomaly: StudioChartAnnotation[] = [
      { id: 'a1', axis: 'x', value: 'row-141', label: '⚠' },
    ];
    await generateAnomalyExplanation('w1', lateAnomaly, controller, AI_CONFIG);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      dataSummary: string;
    };
    expect(body.dataSummary).toContain('row-141'); // anomaly row guaranteed present
    expect(body.dataSummary).toContain('row-0'); // stride rows still present for context
  });
});
