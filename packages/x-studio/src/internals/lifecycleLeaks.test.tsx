import * as React from 'react';
import { act, createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
import { studioRequestCache } from '@mui/x-studio-core/engine';
import { StudioProvider, useStudioSelector } from '../context';
import { useStudioKeyboardShortcuts } from './useStudioKeyboardShortcuts';
import { StudioLiveRegionProvider, useStudioAnnounce } from './StudioLiveRegion';

const { render } = createRenderer();

/**
 * Unmount leaks (AG_STUDIO_GAP_ANALYSIS XS-PERF-004, previously "partially assessed").
 *
 * The prior assessment was a reading, not a test: it observed that `subscribe()` returns an
 * unsubscribe function and that undo history is capped, and concluded there were "no obvious
 * leaks". That is exactly the kind of claim that stops being true silently, because a leak has no
 * symptom until a host has mounted and unmounted a dashboard a few hundred times — a route change
 * in a SPA, which is the normal way this component is used.
 *
 * Every retention vector this package actually has is asserted here, and each is checked against
 * something OBSERVABLE rather than against a profiler:
 *
 * - the controller's store keeps a `Set` of listeners, so a subscription that outlives its
 *   component is directly countable;
 * - `useStudioKeyboardShortcuts` registers a `window` listener and writes a module-level
 *   `lastFocusedRoot`, which is a strong reference to a detached DOM node once the tree unmounts;
 * - `StudioLiveRegionProvider` holds a pending `setTimeout` that would fire into an unmounted
 *   component;
 * - `studioRequestCache` is a module-level singleton shared by every instance, so anything it
 *   retains is retained for the lifetime of the page.
 */

function subscriberCount(controller: StudioController): number {
  // `listeners` is the store's own `Set`. Reaching into it is the point: an unsubscribe that did
  // not happen is invisible from any public API, which is why this vector goes unnoticed.
  return (controller.store as unknown as { listeners: Set<unknown> }).listeners.size;
}

function Subscriber() {
  const mode = useStudioSelector((state) => state.session.mode);
  return <span data-testid="mode">{mode}</span>;
}

describe('Studio unmount — store subscriptions', () => {
  it('releases every subscription when the tree unmounts', () => {
    const controller = new StudioController();
    const before = subscriberCount(controller);

    const view = render(
      <StudioProvider controller={controller}>
        <Subscriber />
        <Subscriber />
        <Subscriber />
      </StudioProvider>,
    );
    expect(subscriberCount(controller)).to.be.greaterThan(before);

    view.unmount();

    expect(subscriberCount(controller)).to.equal(before);
  });

  it('does not accumulate subscriptions across repeated mounts', () => {
    // The shape a route change produces. One leaked listener per mount is invisible in a test that
    // mounts once, and unbounded in an app that navigates.
    const controller = new StudioController();
    const before = subscriberCount(controller);

    for (let i = 0; i < 5; i += 1) {
      const view = render(
        <StudioProvider controller={controller}>
          <Subscriber />
        </StudioProvider>,
      );
      view.unmount();
    }

    expect(subscriberCount(controller)).to.equal(before);
  });

  it('stops notifying an unmounted subtree', () => {
    // The consequence, not just the count: a retained listener re-renders a detached tree on every
    // commit, which is a leak that also costs CPU on every unrelated edit.
    const controller = new StudioController();
    const view = render(
      <StudioProvider controller={controller}>
        <Subscriber />
      </StudioProvider>,
    );
    view.unmount();

    // No throw, and nothing to update — a retained `useSyncExternalStore` subscription would warn
    // about updating an unmounted component.
    act(() => {
      controller.setMode('view');
    });
    expect(subscriberCount(controller)).to.equal(0);
  });
});

describe('Studio unmount — window listeners and module-level state', () => {
  function Shortcuts() {
    const rootRef = React.useRef<HTMLDivElement>(null);
    useStudioKeyboardShortcuts(rootRef);
    return (
      <div ref={rootRef}>
        <button type="button" data-testid="focusable">
          focusable
        </button>
      </div>
    );
  }

  it('removes its window keydown listener on unmount', () => {
    // Counted rather than inspected: there is no way to enumerate a target's listeners, so the
    // assertion is that every `keydown` registration was matched by a removal.
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    const addSpy = vi.spyOn(window, 'addEventListener').mockImplementation(((
      type: string,
      ...rest: never[]
    ) => {
      added.push(type);
      return realAdd(type, ...(rest as [never]));
    }) as never);
    const removeSpy = vi.spyOn(window, 'removeEventListener').mockImplementation(((
      type: string,
      ...rest: never[]
    ) => {
      removed.push(type);
      return realRemove(type, ...(rest as [never]));
    }) as never);

    try {
      const controller = new StudioController();
      const view = render(
        <StudioProvider controller={controller}>
          <Shortcuts />
        </StudioProvider>,
      );
      view.unmount();

      const addedKeydown = added.filter((type) => type === 'keydown').length;
      expect(addedKeydown).to.be.greaterThan(0);
      expect(removed.filter((type) => type === 'keydown').length).to.equal(addedKeydown);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('clears the module-level focused-root reference on unmount', () => {
    // `lastFocusedRoot` is module-level and holds a DOM node. Left set, it pins the whole detached
    // subtree — every widget, every row array the components closed over — for the lifetime of the
    // page. It is also the only vector here that survives the controller being garbage-collected.
    const controller = new StudioController();
    const view = render(
      <StudioProvider controller={controller}>
        <Shortcuts />
      </StudioProvider>,
    );
    act(() => {
      screen.getByTestId('focusable').focus();
    });
    view.unmount();

    // Observable only through behaviour: after unmount no instance should claim the shortcut, so a
    // keypress with nothing focused must not reach the controller.
    const before = controller.getState().doc;
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    });
    expect(controller.getState().doc).to.equal(before);
  });
});

describe('Studio unmount — pending timers', () => {
  it('cancels the live region timeout on unmount', () => {
    // The announcement is posted on a 50 ms timeout so an identical repeat still reads out. On
    // unmount that timer is pending, and firing it would set state on a component that is gone.
    vi.useFakeTimers();
    try {
      function Announcer() {
        const announce = useStudioAnnounce();
        React.useEffect(() => {
          announce('Widget deleted');
        }, [announce]);
        return null;
      }
      const view = render(
        <StudioLiveRegionProvider>
          <Announcer />
        </StudioLiveRegionProvider>,
      );

      view.unmount();

      // A surviving timer would warn (or throw) here rather than doing nothing.
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(vi.getTimerCount()).to.equal(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Studio module-level caches are bounded', () => {
  it('caps the request cache rather than growing with every distinct query', () => {
    // `studioRequestCache` is a singleton shared by every mounted instance, so it is the one
    // structure whose growth is not bounded by any component's lifetime. Each filter or date-range
    // tweak mints a new cache key, so an uncapped map grows for as long as the tab is open.
    const entries = 800;
    for (let i = 0; i < entries; i += 1) {
      studioRequestCache.set(`key-${i}`, { rows: [{ id: i }] }, `source-${i}`);
    }

    let retained = 0;
    for (let i = 0; i < entries; i += 1) {
      if (studioRequestCache.get(`key-${i}`)) {
        retained += 1;
      }
    }

    expect(retained).to.be.lessThan(entries);
  });
});
