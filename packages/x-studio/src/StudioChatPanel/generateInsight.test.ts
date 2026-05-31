import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  generateWidgetInsight,
  generateDashboardSummary,
  generateAnomalyExplanation,
} from './generateInsight';
import type { StudioAIConfig } from './studioAdapter';
import type { StudioController } from '../store/StudioController';
import type { StudioChartAnnotation } from '../models/baseTypes';
import { createDefaultStudioState } from '../models/stateTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

const AI_CONFIG: StudioAIConfig = {
  endpoint: 'https://api.example.com/v1/chat/completions',
  model: 'gpt-4o',
};

function mockFetch(text: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    text: () => Promise.resolve('Error body'),
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: text } }],
      }),
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

  it('sends POST to the configured endpoint', async () => {
    const fetchMock = mockFetch('result');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController('w1');
    await generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'analysis' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(AI_CONFIG.endpoint);
    expect(options.method).toBe('POST');
  });

  it('includes widget title in the request messages', async () => {
    const fetchMock = mockFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController('w1');
    await generateWidgetInsight('w1', controller, AI_CONFIG, { type: 'summary' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: Array<{ content: string }>;
    };
    const combined = body.messages.map((m) => m.content).join(' ');
    expect(combined).toContain('Revenue Chart');
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

  it('includes widget title in the request prompt', async () => {
    const fetchMock = mockFetch('ok');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController('w1');
    await generateDashboardSummary(controller, AI_CONFIG);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: Array<{ content: string }>;
    };
    const combined = body.messages.map((m) => m.content).join(' ');
    expect(combined).toContain('Revenue Chart');
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

  it('includes anomaly labels in the request prompt', async () => {
    const fetchMock = mockFetch('explanation');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController('w1');
    await generateAnomalyExplanation('w1', anomalies, controller, AI_CONFIG);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: Array<{ content: string }>;
    };
    const combined = body.messages.map((m) => m.content).join(' ');
    expect(combined).toContain('August');
    expect(combined).toContain('December');
  });

  it('throws when the widget is not found', async () => {
    const controller = makeController('w1');
    await expect(
      generateAnomalyExplanation('nonexistent', anomalies, controller, AI_CONFIG),
    ).rejects.toThrow('Widget "nonexistent" not found');
  });
});
