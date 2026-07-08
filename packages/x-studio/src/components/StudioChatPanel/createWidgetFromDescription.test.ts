import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createWidgetFromDescription,
  type CreateWidgetResult,
} from './createWidgetFromDescription';
import type { StudioAIConfig } from './studioBackendAdapter';
import type { StudioController } from '../../store/StudioController';
import { createDefaultStudioState } from '../../models/stateTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

const AI_CONFIG: StudioAIConfig = {
  endpoint: 'https://api.example.com/api/ai',
};

function makeController(): StudioController {
  const state = createDefaultStudioState({
    runtime: {
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
    },
  });
  return {
    getState: () => state,
    addWidget: vi.fn(),
  } as unknown as StudioController;
}

function mockCreateWidgetResponse(kind: string, extraConfig: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        kind,
        title: `${kind.charAt(0).toUpperCase() + kind.slice(1)} Widget`,
        sourceId: 'src1',
        config: extraConfig,
      }),
  });
}

// ── Basic success / error paths ───────────────────────────────────────────────

describe('createWidgetFromDescription', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success and calls controller.addWidget on a valid response', async () => {
    vi.stubGlobal('fetch', mockCreateWidgetResponse('chart', { chartType: 'bar' }));
    const controller = makeController();
    const result = await createWidgetFromDescription('bar chart of revenue', AI_CONFIG, controller);
    expect(result).toEqual<CreateWidgetResult>({ success: true });
    expect(controller.addWidget).toHaveBeenCalledOnce();
  });

  it('sends POST to the configured endpoint + /widget', async () => {
    const fetchMock = mockCreateWidgetResponse('chart');
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController();
    await createWidgetFromDescription('bar chart', AI_CONFIG, controller);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${AI_CONFIG.endpoint}/widget`);
    expect(options.method).toBe('POST');
  });

  it('returns failure on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const controller = makeController();
    const result = await createWidgetFromDescription('bar chart', AI_CONFIG, controller);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });

  it('returns failure on non-OK HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limit exceeded'),
      }),
    );
    const controller = makeController();
    const result = await createWidgetFromDescription('bar chart', AI_CONFIG, controller);
    expect(result.success).toBe(false);
    expect(result.error).toContain('429');
  });

  it('returns failure when server returns invalid JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      }),
    );
    const controller = makeController();
    const result = await createWidgetFromDescription('bar chart', AI_CONFIG, controller);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid response');
  });
});

// ── Server config validation / stripping (regression: 2.8) ───────────────────

describe('createWidgetFromDescription: server config validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function getCommittedConfig(controller: StudioController): Record<string, unknown> {
    const widgetArg = (controller.addWidget as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      config: Record<string, unknown>;
    };
    return widgetArg.config;
  }

  it('strips keys not valid for the widget kind', async () => {
    // `chartType` is a Chart-only key; returned for a Grid widget it must be dropped.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            kind: 'grid',
            sourceId: 'src1',
            config: { gridHeight: 400, chartType: 'bar', xField: 'month' },
          }),
      }),
    );
    const controller = makeController();
    const result = await createWidgetFromDescription('grid of revenue', AI_CONFIG, controller);

    expect(result.success).toBe(true);
    const config = getCommittedConfig(controller);
    expect(config.gridHeight).toBe(400);
    expect(config).not.toHaveProperty('chartType');
    expect(config).not.toHaveProperty('xField');
  });

  it('strips chart keys not valid for the resolved chart type', async () => {
    // `sankeyTargetField` is a Sankey-only key; on a bar chart it must be dropped
    // while legitimate bar keys (xField/yField) survive.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            kind: 'chart',
            sourceId: 'src1',
            config: {
              chartType: 'bar',
              xField: 'month',
              yField: 'revenue',
              sankeyTargetField: 'x',
            },
          }),
      }),
    );
    const controller = makeController();
    const result = await createWidgetFromDescription('bar chart', AI_CONFIG, controller);

    expect(result.success).toBe(true);
    const config = getCommittedConfig(controller);
    expect(config.chartType).toBe('bar');
    expect(config.xField).toBe('month');
    expect(config.yField).toBe('revenue');
    expect(config).not.toHaveProperty('sankeyTargetField');
  });

  it('drops an unknown chartType and falls back to the factory default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            kind: 'chart',
            sourceId: 'src1',
            config: { chartType: 'evil-injected-type', xField: 'month' },
          }),
      }),
    );
    const controller = makeController();
    const result = await createWidgetFromDescription('chart', AI_CONFIG, controller);

    expect(result.success).toBe(true);
    const config = getCommittedConfig(controller);
    // Bogus chartType removed; factory default ('bar') retained from base config.
    expect(config.chartType).toBe('bar');
    // xField is valid for the bar family, so it survives.
    expect(config.xField).toBe('month');
  });

  it('ignores a non-object config from the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            kind: 'chart',
            sourceId: 'src1',
            config: 'not-an-object',
          }),
      }),
    );
    const controller = makeController();
    const result = await createWidgetFromDescription('chart', AI_CONFIG, controller);

    expect(result.success).toBe(true);
    const config = getCommittedConfig(controller);
    // Falls back to the factory default config only — no spread of string chars.
    expect(config.chartType).toBe('bar');
    expect(config).not.toHaveProperty('0');
  });
});

// ── Each built-in chart / widget kind ────────────────────────────────────────

const WIDGET_KINDS = [
  { kind: 'chart', extraConfig: { chartType: 'bar' } },
  { kind: 'chart', extraConfig: { chartType: 'line' } },
  { kind: 'chart', extraConfig: { chartType: 'pie' } },
  { kind: 'chart', extraConfig: { chartType: 'area' } },
  { kind: 'chart', extraConfig: { chartType: 'scatter' } },
  { kind: 'chart', extraConfig: { chartType: 'heatmap' } },
  { kind: 'chart', extraConfig: { chartType: 'gantt' } },
  { kind: 'chart', extraConfig: { chartType: 'gauge' } },
  { kind: 'chart', extraConfig: { chartType: 'funnel' } },
  { kind: 'chart', extraConfig: { chartType: 'donut' } },
  { kind: 'kpi', extraConfig: {} },
  { kind: 'grid', extraConfig: {} },
  { kind: 'text', extraConfig: {} },
  { kind: 'pivot', extraConfig: {} },
  { kind: 'map', extraConfig: {} },
] as const;

describe.each(WIDGET_KINDS)(
  'createWidgetFromDescription: kind=$kind chartType=$extraConfig.chartType',
  ({ kind, extraConfig }) => {
    beforeEach(() => {
      vi.stubGlobal('fetch', mockCreateWidgetResponse(kind, extraConfig));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('creates a valid widget via controller.addWidget', async () => {
      const controller = makeController();
      const result = await createWidgetFromDescription(
        `Create a ${kind} widget`,
        AI_CONFIG,
        controller,
      );
      expect(result.success).toBe(true);
      expect(controller.addWidget).toHaveBeenCalledOnce();
      const widgetArg = (controller.addWidget as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as Record<string, unknown>;
      expect(widgetArg.kind).toBe(kind);
      expect(widgetArg.sourceId).toBe('src1');
    });
  },
);
