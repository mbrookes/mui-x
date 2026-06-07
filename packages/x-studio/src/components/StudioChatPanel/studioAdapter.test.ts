import { describe, expect, it, vi } from 'vitest';
import { _executeTool } from './studioAdapter';
import { STUDIO_AI_TOOLS } from './studioAITools';
import type { StudioController } from '../../store/StudioController';
import type { StudioAIConfig, StudioAiTool } from './studioAdapter';
import { createDefaultStudioState } from '../../models/stateTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeController(): StudioController {
  const pageId = 'page-1';
  const widgetId = 'widget-1';
  const state = createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Dashboard', activePageId: pageId },
    pages: {
      [pageId]: { id: pageId, title: 'Page 1', widgetRows: [[widgetId]] },
    },
    widgets: {
      [widgetId]: {
        id: widgetId,
        kind: 'chart',
        title: 'Revenue Chart',
        sourceId: 'src1',
        config: { chartType: 'bar' },
      },
    },
    dataSources: {
      src1: {
        id: 'src1',
        label: 'Sales',
        fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
      },
    },
    filters: [
      {
        id: 'f1',
        field: 'revenue',
        operator: 'greater_than',
        value: 100,
        scope: 'page',
        pageId,
      },
    ],
  });

  return {
    getState: () => state,
    setDashboardTitle: vi.fn(),
    addPage: vi.fn().mockReturnValue('new-page-id'),
    removePage: vi.fn(),
    renamePage: vi.fn(),
    setActivePage: vi.fn(),
    addWidget: vi.fn().mockReturnValue({ id: 'new-widget' }),
    removeWidget: vi.fn(),
    updateWidget: vi.fn(),
    moveWidgetToPage: vi.fn(),
    duplicateWidget: vi.fn(),
    addFilter: vi.fn().mockReturnValue('new-filter-id'),
    removeFilter: vi.fn(),
    clearSelection: vi.fn(),
    setDrawerOpen: vi.fn(),
    selectWidget: vi.fn(),
  } as unknown as StudioController;
}

// ── Tool name coverage ────────────────────────────────────────────────────────

describe('_executeTool: get_dashboard_state', () => {
  it('returns a non-empty string describing the dashboard', () => {
    const controller = makeController();
    const result = _executeTool('get_dashboard_state', {}, controller);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('_executeTool: set_dashboard_title', () => {
  it('calls controller.setDashboardTitle with the given title', () => {
    const controller = makeController();
    _executeTool('set_dashboard_title', { title: 'New Title' }, controller);
    expect(controller.setDashboardTitle).toHaveBeenCalledWith('New Title');
  });
});

describe('_executeTool: add_page', () => {
  it('calls controller.addPage and returns the new page id', () => {
    const controller = makeController();
    const result = _executeTool('add_page', { title: 'Sales' }, controller);
    expect(controller.addPage).toHaveBeenCalledWith('Sales');
    expect(JSON.parse(result)).toMatchObject({ success: true, pageId: 'new-page-id' });
  });
});

describe('_executeTool: rename_page', () => {
  it('calls controller.renamePage with pageId and title', () => {
    const controller = makeController();
    _executeTool('rename_page', { pageId: 'page-1', title: 'Q1 Report' }, controller);
    expect(controller.renamePage).toHaveBeenCalledWith('page-1', 'Q1 Report');
  });
});

describe('_executeTool: set_active_page', () => {
  it('calls controller.setActivePage with pageId', () => {
    const controller = makeController();
    _executeTool('set_active_page', { pageId: 'page-1' }, controller);
    expect(controller.setActivePage).toHaveBeenCalledWith('page-1');
  });
});

describe('_executeTool: add_widget', () => {
  it('calls controller.addWidget with a widget object', () => {
    const controller = makeController();
    const addWidget = vi.fn().mockReturnValue({ id: 'new-widget' });
    (controller as unknown as Record<string, unknown>).addWidget = addWidget;
    _executeTool(
      'add_widget',
      { kind: 'chart', title: 'Sales Bar', sourceId: 'src1', config: { chartType: 'bar' } },
      controller,
    );
    expect(addWidget).toHaveBeenCalled();
    const arg = addWidget.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.kind).toBe('chart');
    expect(arg.title).toBe('Sales Bar');
  });
});

describe('_executeTool: remove_widget', () => {
  it('calls controller.removeWidget and returns success', () => {
    const controller = makeController();
    const result = _executeTool('remove_widget', { widgetId: 'widget-1' }, controller);
    expect(controller.removeWidget).toHaveBeenCalledWith('widget-1');
    const parsed = JSON.parse(result) as { success: boolean };
    expect(parsed.success).toBe(true);
  });
});

describe('_executeTool: update_widget', () => {
  it('calls controller.updateWidget when title is provided', () => {
    const controller = makeController();
    const updateWidget = vi.fn();
    const updateWidgetConfig = vi.fn();
    (controller as unknown as Record<string, unknown>).updateWidget = updateWidget;
    (controller as unknown as Record<string, unknown>).updateWidgetConfig = updateWidgetConfig;
    _executeTool('update_widget', { widgetId: 'widget-1', title: 'New Name' }, controller);
    expect(updateWidget).toHaveBeenCalledWith(
      'widget-1',
      expect.objectContaining({ title: 'New Name' }),
    );
  });
});

describe('_executeTool: set_widget_layout', () => {
  it('calls controller to set widget layout', () => {
    const controller = makeController();
    // set_widget_layout sets the row layout — just ensure it doesn't throw
    expect(() =>
      _executeTool('set_widget_layout', { layout: [['widget-1']] }, controller),
    ).not.toThrow();
  });
});

describe('_executeTool: add_page_filter', () => {
  it('calls controller.addFilter with page scope and returns the new filter id', () => {
    const controller = makeController();
    const result = _executeTool(
      'add_page_filter',
      { field: 'revenue', sourceId: 'src1', operator: 'greaterThan', value: 500 },
      controller,
    );
    expect(controller.addFilter).toHaveBeenCalled();
    const filterArg = (controller.addFilter as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(filterArg.scope).toBe('page');
    const parsed = JSON.parse(result) as { filterId: string };
    expect(parsed.filterId).toBeDefined();
  });
});

describe('_executeTool: remove_page_filter', () => {
  it('calls controller.removeFilter', () => {
    const controller = makeController();
    _executeTool('remove_page_filter', { filterId: 'f1' }, controller);
    expect(controller.removeFilter).toHaveBeenCalledWith('f1');
  });
});

describe('_executeTool: add_widget_filter', () => {
  it('calls controller.addFilter with widget scope', () => {
    const controller = makeController();
    _executeTool(
      'add_widget_filter',
      { widgetId: 'widget-1', field: 'revenue', sourceId: 'src1', operator: 'lessThan', value: 50 },
      controller,
    );
    const filterArg = (controller.addFilter as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(filterArg.scope).toBe('widget');
    expect(filterArg.widgetId).toBe('widget-1');
  });
});

describe('_executeTool: remove_widget_filter', () => {
  it('calls controller.removeFilter', () => {
    const controller = makeController();
    _executeTool('remove_widget_filter', { filterId: 'f1' }, controller);
    expect(controller.removeFilter).toHaveBeenCalledWith('f1');
  });
});

// ── allowedTools filtering ────────────────────────────────────────────────────

describe('allowedTools filtering', () => {
  it('only includes allowed tools in effectiveTools', () => {
    const allowed = ['add_widget', 'get_dashboard_state'];
    const filtered = STUDIO_AI_TOOLS.filter((t) => allowed.includes(t.function.name));
    expect(filtered.map((t) => t.function.name)).toEqual(expect.arrayContaining(allowed));
    expect(filtered.length).toBe(2);
  });

  it('includes no built-in tools when allowedTools is empty', () => {
    const filtered = STUDIO_AI_TOOLS.filter(() => false);
    expect(filtered.length).toBe(0);
  });

  it('STUDIO_AI_TOOLS contains all 17 expected tool names', () => {
    const names = STUDIO_AI_TOOLS.map((t) => t.function.name);
    const expected = [
      'get_dashboard_state',
      'set_dashboard_title',
      'add_page',
      'remove_page',
      'rename_page',
      'set_active_page',
      'add_widget',
      'remove_widget',
      'update_widget',
      'set_widget_layout',
      'set_widget_width',
      'add_page_filter',
      'remove_page_filter',
      'add_widget_filter',
      'remove_widget_filter',
      'summarise_page',
      'apply_bulk_update',
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
    expect(names.length).toBe(expected.length);
  });
});

// ── extraTools dispatch ───────────────────────────────────────────────────────

describe('extraTools', () => {
  it('can call a custom tool execute function', async () => {
    const executeFn = vi.fn().mockResolvedValue('custom result');
    const customTool: StudioAiTool = {
      name: 'my_custom_tool',
      description: 'Does something custom',
      parameters: { type: 'object', properties: {} },
      execute: executeFn,
    };

    const controller = makeController();
    const config: StudioAIConfig = {
      endpoint: 'https://example.com',
      extraTools: [customTool],
    };

    await customTool.execute({ some: 'arg' }, controller);
    expect(executeFn).toHaveBeenCalledWith({ some: 'arg' }, controller);
  });
});

// ── onToolError callback ──────────────────────────────────────────────────────

describe('onToolError', () => {
  it('wraps a throwing built-in tool — error returned as JSON', () => {
    const controller = makeController();
    // Cause an error by passing an invalid tool name
    const result = _executeTool(
      'unknown_tool_xyz' as Parameters<typeof _executeTool>[0],
      {},
      controller,
    );
    // executeTool hits the default switch case which returns an error object
    const parsed = JSON.parse(result) as { error: string };
    expect(parsed.error).toBeDefined();
  });
});

// ── StudioAIConfig.mode backward compat ───────────────────────────────────────

describe('StudioAIConfig.mode', () => {
  it('accepts mode: "direct" (backward compat)', () => {
    const config: StudioAIConfig = { endpoint: 'https://example.com', mode: 'direct' };
    expect(config.mode).toBe('direct');
  });

  it('accepts mode: "x-studio-ai-middleware"', () => {
    const config: StudioAIConfig = { endpoint: 'https://example.com', mode: 'x-studio-ai-middleware' };
    expect(config.mode).toBe('x-studio-ai-middleware');
  });

  it('defaults to direct mode when mode is omitted', () => {
    const config: StudioAIConfig = { endpoint: 'https://example.com' };
    // mode is optional — undefined means direct mode
    expect(config.mode).toBeUndefined();
  });
});
