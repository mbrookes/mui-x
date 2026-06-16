/**
 * Unit tests for the single-shot LLM helpers in handleGenerateInsight.ts:
 * `handleGenerateInsight`, `handleGenerateTitle`, and `handleCreateWidget`.
 *
 * Each is a pure function over a stubbed global `fetch`. The tests pin down
 * prompt selection, request shape, response parsing, and the fallback / error
 * branches without contacting an LLM.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleGenerateInsight,
  handleGenerateTitle,
  handleCreateWidget,
  type GenerateInsightRequest,
} from './handleGenerateInsight';

const OPTIONS = { endpoint: 'https://llm.test/v1/chat', apiKey: 'sk-test' };

function stubFetch(content: string, init: { ok?: boolean; status?: number; text?: string } = {}) {
  const ok = init.ok ?? true;
  const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: 'ERR',
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => init.text ?? '',
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function requestBody(fn: ReturnType<typeof stubFetch>) {
  return JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
}

const baseRequest: GenerateInsightRequest = {
  insightType: 'summary',
  widgetKind: 'bar-chart',
  widgetTitle: 'Revenue by Region',
  dataSummary: 'EMEA: 100, APAC: 80',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleGenerateInsight', () => {
  it('returns the trimmed completion text', async () => {
    stubFetch('  Revenue is concentrated in EMEA.  ');
    expect(await handleGenerateInsight(baseRequest, OPTIONS)).toBe(
      'Revenue is concentrated in EMEA.',
    );
  });

  it('returns an empty string when the response has no content', async () => {
    const fn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
    }));
    vi.stubGlobal('fetch', fn);
    expect(await handleGenerateInsight(baseRequest, OPTIONS)).toBe('');
  });

  it.each([
    ['summary', 'concise business analyst'],
    ['analysis', 'data analyst'],
    ['forecast', 'forecasting analyst'],
    ['anomaly', 'data quality analyst'],
    ['correlation', 'correlation analysis'],
  ] as const)('selects the %s system prompt', async (insightType, marker) => {
    const fn = stubFetch('ok');
    await handleGenerateInsight({ ...baseRequest, insightType }, OPTIONS);
    expect(requestBody(fn).messages[0].content).toContain(marker);
  });

  it('appends the forecast horizon to the user message only for forecasts', async () => {
    const fn = stubFetch('ok');
    await handleGenerateInsight(
      { ...baseRequest, insightType: 'forecast', forecastPeriods: 6 },
      OPTIONS,
    );
    expect(requestBody(fn).messages[1].content).toContain('Forecast horizon: 6 periods.');
  });

  it('does not append a forecast horizon for non-forecast insights', async () => {
    const fn = stubFetch('ok');
    await handleGenerateInsight({ ...baseRequest, forecastPeriods: 6 }, OPTIONS);
    expect(requestBody(fn).messages[1].content).not.toContain('Forecast horizon');
  });

  it('uses the default model and insight token/temperature budget', async () => {
    const fn = stubFetch('ok');
    await handleGenerateInsight(baseRequest, OPTIONS);
    const body = requestBody(fn);
    expect(body.model).toBe('gpt-4o');
    expect(body.max_tokens).toBe(300);
    expect(body.temperature).toBe(0.4);
  });

  it('passes the abort signal through to fetch', async () => {
    const fn = stubFetch('ok');
    const controller = new AbortController();
    await handleGenerateInsight({ ...baseRequest, signal: controller.signal }, OPTIONS);
    expect((fn.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it('throws with status and body on a non-OK response', async () => {
    stubFetch('', { ok: false, status: 503, text: 'unavailable' });
    await expect(handleGenerateInsight(baseRequest, OPTIONS)).rejects.toThrow(
      /Insight generation failed: 503 unavailable/,
    );
  });
});

describe('handleGenerateTitle', () => {
  it('parses the JSON title/description', async () => {
    stubFetch(JSON.stringify({ title: 'Sales Review', description: 'A look at sales.' }));
    expect(await handleGenerateTitle('show me sales', OPTIONS)).toEqual({
      title: 'Sales Review',
      description: 'A look at sales.',
    });
  });

  it('falls back to a truncated message when content is not valid JSON', async () => {
    const message = 'a'.repeat(60);
    stubFetch('not json');
    expect(await handleGenerateTitle(message, OPTIONS)).toEqual({
      title: message.slice(0, 40),
      description: '',
    });
  });

  it('throws on a non-OK response', async () => {
    stubFetch('', { ok: false, status: 500 });
    await expect(handleGenerateTitle('hi', OPTIONS)).rejects.toThrow(
      /Title generation failed: 500/,
    );
  });
});

describe('handleCreateWidget', () => {
  const request = {
    description: 'a bar chart of revenue by region',
    sources: [
      {
        id: 'src-sales',
        label: 'Sales',
        fields: [
          { id: 'revenue', type: 'number', label: 'Revenue' },
          { id: 'region', type: 'string' },
        ],
      },
    ],
  };

  it('returns the parsed widget configuration', async () => {
    stubFetch(JSON.stringify({ kind: 'chart', title: 'Revenue by Region', sourceId: 'src-sales' }));
    expect(await handleCreateWidget(request, OPTIONS)).toEqual({
      kind: 'chart',
      title: 'Revenue by Region',
      sourceId: 'src-sales',
    });
  });

  it('includes the available sources and their fields in the system prompt', async () => {
    const fn = stubFetch(JSON.stringify({ kind: 'chart', title: 't' }));
    await handleCreateWidget(request, OPTIONS);
    const systemPrompt = requestBody(fn).messages[0].content as string;
    expect(systemPrompt).toContain('Sales [id: src-sales]');
    expect(systemPrompt).toContain('revenue (number, "Revenue")');
    expect(systemPrompt).toContain('region (string)');
  });

  it('shows a "(none yet)" placeholder when there are no sources', async () => {
    const fn = stubFetch(JSON.stringify({ kind: 'text', title: 't' }));
    await handleCreateWidget({ description: 'a note', sources: [] }, OPTIONS);
    expect(requestBody(fn).messages[0].content as string).toContain('(none yet)');
  });

  it('throws when the model returns invalid JSON', async () => {
    stubFetch('definitely not json');
    await expect(handleCreateWidget(request, OPTIONS)).rejects.toThrow(
      /invalid widget configuration/,
    );
  });

  it('throws on a non-OK response', async () => {
    stubFetch('', { ok: false, status: 400 });
    await expect(handleCreateWidget(request, OPTIONS)).rejects.toThrow(
      /Widget creation failed: 400/,
    );
  });
});
