import * as React from 'react';
import { createRenderer, act, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useStudioDropTarget } from './useStudioDropTarget';
import { DRAG_TYPE_CANVAS_WIDGET, type StudioDragItem } from './studioWidgetDndTypes';

/**
 * Registration-time capture coverage for the canvas drop targets.
 *
 * pragmatic-drag-and-drop's `dropTargetForElements` takes its `canDrop`/`onDrop` ONCE, at
 * registration. `react-hooks/exhaustive-deps` cannot see into that call, so a stale closure
 * over a prop or a piece of state is invisible to lint and to pattern-matching review — the
 * same class as the stale-closure defects already fixed elsewhere in this package. These
 * tests pin the two properties that keep it correct: the callbacks are read through refs at
 * DRAG time (never captured), and `watch` re-registers when the ref is re-attached to a
 * different DOM node.
 *
 * jsdom can't fire real pointer drags, so the adapter is mocked into a registry keyed by
 * element, mirroring pragmatic's real contract (`canDrop` gates `onDrop`).
 */
interface RegisteredTarget {
  element: Element;
  canDrop: (arg: { source: { data: unknown } }) => boolean;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (arg: { source: { data: unknown } }) => void;
}

const { registry, registrations } = vi.hoisted(() => ({
  registry: new Map<Element, RegisteredTarget>(),
  registrations: [] as RegisteredTarget[],
}));

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  dropTargetForElements: (opts: RegisteredTarget) => {
    registry.set(opts.element, opts);
    registrations.push(opts);
    return () => {
      registry.delete(opts.element);
    };
  },
  draggable: () => () => {},
  monitorForElements: () => () => {},
}));

const { render } = createRenderer();

const item: StudioDragItem = {
  type: DRAG_TYPE_CANVAS_WIDGET,
  widgetId: 'w1',
  sourcePageId: 'p1',
};

/** Emulates pragmatic's contract: `canDrop` gates whether `onDrop` runs. */
function fireDrop(target: RegisteredTarget): boolean {
  const arg = { source: { data: item as unknown as Record<string, unknown> } };
  if (!target.canDrop(arg)) {
    return false;
  }
  target.onDrop(arg);
  return true;
}

function Target({
  canDrop,
  onDrop,
}: {
  canDrop: (i: StudioDragItem) => boolean;
  onDrop: (i: StudioDragItem) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const isOver = useStudioDropTarget({ ref, canDrop, onDrop });
  return <div ref={ref} data-testid="target" data-over={isOver ? '' : undefined} />;
}

/**
 * Reproduces the finding-1.4 shape: the ref'd element lives in one of two mutually
 * exclusive branches of a persistent component, so `ref.current` points at a DIFFERENT DOM
 * node after the branch flips even though `ref` itself never changes identity.
 */
function BranchedTarget({ branch, watch }: { branch: 'a' | 'b'; watch: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useStudioDropTarget({
    ref,
    canDrop: () => true,
    onDrop: () => {},
    watch: watch ? branch : undefined,
  });
  return branch === 'a' ? (
    <div ref={ref} data-testid="branch-a" />
  ) : (
    <section ref={ref} data-testid="branch-b" />
  );
}

describe('useStudioDropTarget', () => {
  beforeEach(() => {
    registry.clear();
    registrations.length = 0;
  });

  it('reads the LATEST canDrop at drag time, not the one captured at registration', () => {
    const { setProps } = render(<Target canDrop={() => false} onDrop={() => {}} />);
    const target = registry.get(screen.getByTestId('target'))!;
    expect(fireDrop(target)).toBe(false);

    // The registration effect does NOT re-run (its deps are `[ref, watch]`), so this only
    // passes if `canDrop` is read through a ref rather than closed over at registration.
    // (The count is not asserted absolutely: `createRenderer` renders under StrictMode,
    // which double-invokes the mount effect.)
    const registrationsAtMount = registrations.length;
    setProps({ canDrop: () => true });
    expect(registrations).toHaveLength(registrationsAtMount);
    expect(fireDrop(target)).toBe(true);
  });

  it('calls the LATEST onDrop, not the one captured at registration', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { setProps } = render(<Target canDrop={() => true} onDrop={first} />);
    const target = registry.get(screen.getByTestId('target'))!;

    setProps({ onDrop: second });
    fireDrop(target);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(item);
  });

  it('ignores drag data that is not a studio drag item', () => {
    const onDrop = vi.fn();
    render(<Target canDrop={() => true} onDrop={onDrop} />);
    const target = registry.get(screen.getByTestId('target'))!;

    const foreign = { source: { data: { type: 'some-other-library' } } };
    expect(target.canDrop(foreign)).toBe(false);
    target.onDrop(foreign);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('clears isOver on drag leave (pragmatic fires this on cancel, before drag end)', () => {
    render(<Target canDrop={() => true} onDrop={() => {}} />);
    const target = registry.get(screen.getByTestId('target'))!;

    act(() => target.onDragEnter());
    expect(screen.getByTestId('target').hasAttribute('data-over')).toBe(true);

    // A cancelled drag empties `location.current.dropTargets`, which pragmatic surfaces as
    // `onDragLeave` — the target's own `onDrop` never runs, so this is the only reset path.
    act(() => target.onDragLeave());
    expect(screen.getByTestId('target').hasAttribute('data-over')).toBe(false);
  });

  it('re-registers on the new DOM node when `watch` changes with the rendered branch', () => {
    const { setProps } = render(<BranchedTarget branch="a" watch />);
    expect(registry.has(screen.getByTestId('branch-a'))).toBe(true);

    setProps({ branch: 'b' });
    // The old node's registration is torn down and the newly-attached one takes its place.
    expect(registry.size).toBe(1);
    expect(registry.has(screen.getByTestId('branch-b'))).toBe(true);
  });
});
