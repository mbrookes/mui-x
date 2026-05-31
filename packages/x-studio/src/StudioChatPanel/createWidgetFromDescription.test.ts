import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createWidgetFromDescription,
  type CreateWidgetResult,
} from './createWidgetFromDescription';
import type { StudioAIConfig } from './studioAdapter';
import type { StudioController } from '../store/StudioController';
import { createDefaultStudioState } from '../models/stateTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

const AI_CONFIG: StudioAIConfig = {
  endpoint: 'https://api.example.com/v1/chat/completions',
  model: 'gpt-4o',
};

function makeController(): StudioController {
  const state = createDefaultStudioState({
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
  return {
    getState: () => state,
    addWidget: vi.fn(),
  } as unknown as StudioController;
}

function mockAddWidgetResponse(kind: string, extraArgs: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'add_widget',
                    arguments: JSON.stringify({
                      kind,
                      title: `${kind.charAt(0).toUpperCase() + kind.slice(1)} Widget`,
                      sourceId: 'src1',
                      ...extraArgs,
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
  });
}

// ── Basic success / error paths ───────────────────────────────────────────────

describe('createWidgetFromDescription', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success and calls controller.addWidget on a valid AI response', async () => {
    vi.stubGlobal('fetch', mockAddWidgetResponse('chart', { config: { chartType: 'bar' } }));
    const controller = makeController();
    const result = await createWidgetFromDescription('bar chart of revenue', AI_CONFIG, controller);
    expect(result).toEqual<CreateWidgetResult>({ success: true });
    expect(controller.addWidget).toHaveBeenCalledOnce();
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

  it('returns failure when AI does not return a tool call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'I cannot create a widget.' } }],
          }),
      }),
    );
    const controller = makeController();
    const result = await createWidgetFromDescription('bar chart', AI_CONFIG, controller);
    expect(result.success).toBe(false);
    expect(result.error).toContain('did not create a widget');
  });

  it('returns failure when AI returns invalid JSON arguments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  tool_calls: [{ function: { name: 'add_widget', arguments: 'not-valid-json{{' } }],
                },
              },
            ],
          }),
      }),
    );
    const controller = makeController();
    const result = await createWidgetFromDescription('bar chart', AI_CONFIG, controller);
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid widget configuration');
  });
});

// ── Each built-in chart / widget kind ────────────────────────────────────────

const WIDGET_KINDS = [
  { kind: 'chart', extraArgs: { config: { chartType: 'bar' } } },
  { kind: 'chart', extraArgs: { config: { chartType: 'line' } } },
  { kind: 'chart', extraArgs: { config: { chartType: 'pie' } } },
  { kind: 'chart', extraArgs: { config: { chartType: 'area' } } },
  { kind: 'chart', extraArgs: { config: { chartType: 'scatter' } } },
  { kind: 'chart', extraArgs: { config: { chartType: 'heatmap' } } },
  { kind: 'chart', extraArgs: { config: { chartType: 'gantt' } } },
  { kind: 'chart', extraArgs: { config: { chartType: 'gauge' } } },
  { kind: 'chart', extraArgs: { config: { chartType: 'funnel' } } },
  { kind: 'chart', extraArgs: { config: { chartType: 'donut' } } },
  { kind: 'kpi', extraArgs: {} },
  { kind: 'grid', extraArgs: {} },
  { kind: 'text', extraArgs: {} },
  { kind: 'pivot', extraArgs: {} },
  { kind: 'map', extraArgs: {} },
] as const;

describe.each(WIDGET_KINDS)(
  'createWidgetFromDescription: kind=$kind chartType=$extraArgs.config.chartType',
  ({ kind, extraArgs }) => {
    beforeEach(() => {
      vi.stubGlobal('fetch', mockAddWidgetResponse(kind, extraArgs));
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
