/**
 * Controller behaviour that can only be asserted where BOTH packages are visible.
 *
 * These moved out of `@mui/x-studio-core`'s own controller suite when the engine was extracted:
 * one asserts that the controller's column-span clamp agrees with the canvas's `getWidgetMinSpan`,
 * the other that a chat-turn revert round-trips through the controller. Each is a claim about the
 * agreement between the engine and its React binding, so it belongs on the side that can see both.
 */
import { describe, expect, it } from 'vitest';
import { GRID_COLS, MIN_SPAN } from '@mui/x-studio-schema';
import { StudioController } from '@mui/x-studio-core/store';
import type { StudioWidget } from '../models';
import { getWidgetMinSpan } from '../components/StudioCanvas/StudioCanvas';
import { createChatTurnMutationLedger } from '../components/StudioChatPanel/chatTurnMutations';

function makeWidget(id: string, overrides: Partial<StudioWidget> = {}): StudioWidget {
  // `...overrides` (a `Partial<StudioWidget>`) broadens `kind`/`config` beyond a
  // single discriminated union member, so cast through `unknown` — this generic
  // test factory intentionally accepts any kind + config combination.
  return {
    id,
    kind: 'kpi',
    title: 'Test Widget',
    config: { kpiAggregation: 'sum' },
    ...overrides,
  } as unknown as StudioWidget;
}

describe('StudioController — dangling selection normalization at the commit choke point', () => {
  it('setState nulls a selection the swapped-in doc no longer contains', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const docBefore = controller.getState().doc;

    controller.addWidget(makeWidget('ai1'));
    expect(controller.getState().session.shell.selectedWidgetId).toBe('ai1');

    // The whole-state swap `chatTurnMutations`' `revert` performs.
    controller.setState({ ...controller.getState(), doc: docBefore }, { undoable: true });

    expect(controller.getState().doc.widgets).not.toHaveProperty('ai1');
    expect(controller.getState().session.shell.selectedWidgetId).toBe(null);
  });

  it('chat Retry (ledger revert) does not leave the reverted widget selected', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    const ledger = createChatTurnMutationLedger(controller);

    const docBefore = controller.getState().doc;
    const pageId = controller.getState().doc.dashboard.activePageId;
    controller.applyExternalMutation({
      type: 'addWidget',
      args: { widget: makeWidget('ai1'), pageId },
    });
    const docAfter = controller.getState().doc;
    ledger.record('msg-1', docBefore, docAfter);

    // Selecting the AI-created widget is a SESSION-only commit, so `doc` stays
    // reference-identical and the ledger's staleness guard still passes.
    controller.setSelectedWidget('ai1');
    expect(controller.getState().doc).toBe(docAfter);

    expect(ledger.revert('msg-1')).toBe(true);

    expect(Object.keys(controller.getState().doc.widgets)).toEqual(['w1']);
    // Without the normalization the compose drawer renders a blank `WidgetConfigView`
    // keyed on the vanished id instead of `AddWidgetView`.
    expect(controller.getState().session.shell.selectedWidgetId).toBe(null);
  });

  it('leaves a still-present selection and the state reference alone', () => {
    const controller = new StudioController();
    controller.addWidget(makeWidget('w1'));
    controller.setSelectedWidget('w1');

    controller.setDashboardTitle('renamed');

    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');
  });
});

// ─── R6 F2: the non-reducer-routed writers screen their payloads too ──────────

describe('setAdjacentWidgetColSpans — canvas min-span vocabulary matches the doc floor', () => {
  it('commits exactly the minimum getWidgetMinSpan offers for a sparkline-less KPI', () => {
    const kpi = makeWidget('k1', { kind: 'kpi', config: {} });
    const controller = new StudioController({
      doc: {
        widgets: { k1: kpi, w2: makeWidget('w2') },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['k1', 'w2']] },
        },
        dashboard: { activePageId: 'page-1' } as never,
      },
    });

    // The exact number `RowResizeHandle` publishes as `aria-valuemin` and announces.
    const offeredMin = getWidgetMinSpan(kpi);
    controller.setAdjacentWidgetColSpans(
      'k1',
      offeredMin,
      'w2',
      GRID_COLS - offeredMin,
      offeredMin,
      MIN_SPAN,
    );

    // Before R6 F4 the canvas offered 4 while the reducer's `clampSpan` committed 6, so the
    // handle's `aria-valuemin` and its announcement both described a width the document
    // cannot represent.
    expect(controller.getState().doc.pages['page-1'].widgetColSpans?.k1).toBe(offeredMin);
  });
});

// ─── R6 F3: the controller's non-reducer filter drops cascade too ────────────
