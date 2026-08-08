import * as React from 'react';
import { act, createRenderer } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { useStudioDropTarget } from './useStudioDropTarget';
import type { StudioDragItem } from './studioWidgetDndTypes';

/**
 * The render cost of a drag (AG_STUDIO_GAP_ANALYSIS XS-PERF-001, "60 fps drag").
 *
 * The spec asks for "no frame drop measured with React DevTools Profiler", which is not a thing a
 * jsdom test can honestly claim to have done. But a frame measurement would be the wrong guard
 * anyway: it is flaky in CI, it depends on the machine, and it tells you a regression happened
 * without telling you what caused it.
 *
 * So this pins the PROPERTY that determines the frame rate instead. Dragging fires enter/leave
 * events continuously as the pointer crosses drop targets, and there is exactly one way for that
 * to drop frames in this design: if the highlight state lived somewhere shared — canvas state, the
 * controller store, a context — every pointer move would re-render every widget on the page, and
 * the cost would scale with dashboard size.
 *
 * It does not. `useStudioDropTarget` holds `isOver` in LOCAL state, so a drag re-renders only the
 * targets whose own hover state changed, however many widgets are on the page. That is a structural
 * guarantee, and a structural guarantee is exactly the kind of thing a test can hold onto.
 *
 * These would all still pass if someone made the drag 10× slower in a way unrelated to renders.
 * That is a real limitation and it is why the module says what it measures.
 */

const { render } = createRenderer();

interface DropTargetHandlers {
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (args: { source: { data: unknown } }) => void;
  canDrop: (args: { source: { data: unknown } }) => boolean;
}

/** Registered handlers, keyed by the `data-testid` of the element they were registered on. */
const registered = new Map<string, DropTargetHandlers>();

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  dropTargetForElements: (config: { element: HTMLElement } & DropTargetHandlers) => {
    const key = config.element.dataset.testid ?? '';
    registered.set(key, config);
    return () => registered.delete(key);
  },
}));

const DRAG_ITEM = { type: 'studio-widget', widgetId: 'w1' } as unknown as StudioDragItem;

/** One drop target that counts its own renders. */
function CountingTarget({ id, renders }: { id: string; renders: Map<string, number> }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const isOver = useStudioDropTarget({
    ref,
    canDrop: () => true,
    onDrop: () => {},
  });
  renders.set(id, (renders.get(id) ?? 0) + 1);
  return <div ref={ref} data-testid={id} data-over={isOver ? '' : undefined} />;
}

/** A widget body that must NOT re-render while a drag crosses the targets around it. */
function CountingWidget({ id, renders }: { id: string; renders: Map<string, number> }) {
  renders.set(id, (renders.get(id) ?? 0) + 1);
  return <div data-testid={id} />;
}

const MemoWidget = React.memo(CountingWidget);

function enter(id: string) {
  act(() => {
    registered.get(id)?.onDragEnter();
  });
}

function leave(id: string) {
  act(() => {
    registered.get(id)?.onDragLeave();
  });
}

describe('drag render cost', () => {
  it('re-renders only the target whose hover state changed', () => {
    const renders = new Map<string, number>();
    render(
      <React.Fragment>
        <CountingTarget id="t1" renders={renders} />
        <CountingTarget id="t2" renders={renders} />
        <CountingTarget id="t3" renders={renders} />
      </React.Fragment>,
    );
    const baseline = new Map(renders);

    enter('t2');

    expect(renders.get('t2')).to.be.greaterThan(baseline.get('t2')!);
    // The other two are untouched. If `isOver` were lifted into shared state, both would have
    // re-rendered — and on a real dashboard so would every widget between them.
    expect(renders.get('t1')).to.equal(baseline.get('t1'));
    expect(renders.get('t3')).to.equal(baseline.get('t3'));
  });

  it('does not re-render widget bodies while the pointer crosses targets', () => {
    // The assertion that actually corresponds to a dropped frame. A widget body is the expensive
    // thing on the page — a chart re-computing its series, a grid re-virtualizing — so a drag that
    // re-rendered them would stutter in proportion to how much data the dashboard shows.
    const renders = new Map<string, number>();
    render(
      <React.Fragment>
        <MemoWidget id="widget" renders={renders} />
        <CountingTarget id="t1" renders={renders} />
        <CountingTarget id="t2" renders={renders} />
      </React.Fragment>,
    );
    const widgetRenders = renders.get('widget');

    enter('t1');
    leave('t1');
    enter('t2');
    leave('t2');

    expect(renders.get('widget')).to.equal(widgetRenders);
  });

  it('costs the same per hover however many targets are mounted', () => {
    // The scaling property. A drag over a 4-widget dashboard and a 40-widget dashboard must cost
    // the same per pointer move, which is only true while the state stays local.
    function measure(targetCount: number): number {
      registered.clear();
      const renders = new Map<string, number>();
      const view = render(
        <React.Fragment>
          {Array.from({ length: targetCount }, (_, i) => (
            <CountingTarget key={i} id={`t${i}`} renders={renders} />
          ))}
        </React.Fragment>,
      );
      const before = Array.from(renders.values()).reduce((a, b) => a + b, 0);
      enter('t0');
      leave('t0');
      const after = Array.from(renders.values()).reduce((a, b) => a + b, 0);
      view.unmount();
      return after - before;
    }

    expect(measure(20)).to.equal(measure(4));
  });

  it('ignores a hover it cannot accept, so no render happens at all', () => {
    // Pragmatic does not fire enter/leave when `canDrop` is false, and `isOver` is documented to
    // mean "over AND droppable". Re-rendering for a hover that can never become a drop would be
    // pure cost — and it is the shape a naive `isOver` implementation has.
    const renders = new Map<string, number>();
    function RejectingTarget() {
      const ref = React.useRef<HTMLDivElement>(null);
      const isOver = useStudioDropTarget({
        ref,
        canDrop: () => false,
        onDrop: () => {},
      });
      renders.set('reject', (renders.get('reject') ?? 0) + 1);
      return <div ref={ref} data-testid="reject" data-over={isOver ? '' : undefined} />;
    }
    render(<RejectingTarget />);
    const before = renders.get('reject');

    expect(registered.get('reject')?.canDrop({ source: { data: DRAG_ITEM } })).to.equal(false);
    expect(renders.get('reject')).to.equal(before);
  });
});
