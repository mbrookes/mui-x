import * as React from 'react';

// How far from the top of the viewport a section title has to scroll before
// it's considered "current" — matches roughly where a reader's eye lands.
const SCROLL_SPY_ACTIVATION_LINE = 96;

/**
 * Keeps the URL hash pointed at whichever example is currently in view, so
 * scrolling through a gallery is shareable/bookmarkable/back-button-able
 * without an explicit click on an anchor. On every (rAF-throttled) scroll,
 * walks the section titles (an element with `id={example.name}` per entry) in
 * document order and takes the last one that has scrolled up to or past the
 * activation line — i.e. the most recent heading the reader has scrolled past,
 * not merely whatever overlaps the (tall) viewport. Unlike an
 * `IntersectionObserver` band, this can't land in a gap between two distant
 * headings and momentarily lose the "current" id. `history.replaceState` is
 * used rather than `location.hash` so updating it doesn't itself trigger a
 * scroll or push a new (back-button) history entry per section.
 */
export function useScrollSpyHash(ids: readonly string[]): void {
  React.useEffect(() => {
    if (ids.length === 0) {
      return undefined;
    }
    let current = '';
    let ticking = false;

    const computeCurrent = () => {
      ticking = false;
      let next = '';
      // `ids` is in document order, so the first heading still below the
      // activation line means every later one is too — stop there.
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el || el.getBoundingClientRect().top > SCROLL_SPY_ACTIVATION_LINE) {
          break;
        }
        next = id;
      }
      if (next === current) {
        return;
      }
      current = next;
      const { pathname, search } = window.location;
      window.history.replaceState(
        null,
        '',
        next ? `${pathname}${search}#${next}` : `${pathname}${search}`,
      );
    };

    const handleScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(computeCurrent);
      }
    };

    // A hash present on mount (a shared/bookmarked deep link) needs an
    // explicit scroll: the browser's own "scroll to the fragment" pass runs
    // once, before this client-rendered SPA has mounted anything to scroll
    // to, so it silently does nothing. Honor it here instead, and seed
    // `current` so the scroll listener doesn't immediately overwrite it
    // before the browser has caught up with the jump.
    const initialId = window.location.hash.slice(1);
    const initialEl =
      initialId && ids.includes(initialId) ? document.getElementById(initialId) : null;
    if (initialEl) {
      initialEl.scrollIntoView({ block: 'start' });
      current = initialId;
    } else {
      computeCurrent();
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [ids]);
}
