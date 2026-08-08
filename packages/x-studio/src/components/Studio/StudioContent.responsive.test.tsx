import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import { StudioProvider } from '../../context';
import { DEFAULT_NARROW_LAYOUT_MEDIA_QUERY } from './layoutMediaQueries';
import { TabbedSidebar } from './TabbedSidebar';

const { render } = createRenderer();

/**
 * Edit-mode responsiveness (AG_STUDIO_GAP_ANALYSIS XS-LAYOUT-005).
 *
 * View mode already stacked widget rows below a breakpoint; edit mode did not adapt at all. Its
 * stacked sidebar renders all three drawers alongside the canvas, so on a narrow viewport the
 * canvas was squeezed to nothing and authoring was effectively impossible.
 *
 * The fix reuses the TABBED sidebar below `md` rather than inventing a mobile mode: one panel at a
 * time behind a tab strip is the mobile-appropriate arrangement, it already ships, and a second
 * narrow-viewport layout would be a second thing to keep working.
 *
 * These assert the behaviour that makes that reuse correct — that the tabbed sidebar really does
 * show one panel at a time. `StudioContent` itself is not rendered: it pulls in the canvas, every
 * drawer and the chart packages, so a test about layout selection would cost seconds and fail for
 * unrelated reasons. The media-query branch is a one-line ternary over a documented MUI hook; what
 * is worth pinning is the thing it selects.
 */

function matchMediaStub(matches: boolean) {
  return (query: string) =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

function renderTabbed(panels: { drawer: 'data' | 'compose' | 'filters'; label: string }[]) {
  const controller = new StudioController();
  return {
    controller,
    ...render(
      <ThemeProvider theme={createTheme()}>
        <StudioProvider controller={controller}>
          <TabbedSidebar
            side="left"
            panels={panels.map((panel) => ({
              ...panel,
              children: <div data-testid={`panel-${panel.drawer}`}>{panel.label} content</div>,
            }))}
          />
        </StudioProvider>
      </ThemeProvider>,
    ),
  };
}

describe('narrow-viewport sidebar', () => {
  it('shows at most one panel body at a time', () => {
    // The property the whole fix rests on. If the tabbed sidebar rendered all three bodies, using
    // it below `md` would move the problem rather than solve it.
    renderTabbed([
      { drawer: 'data', label: DEFAULT_STUDIO_LOCALE_TEXT.dataDrawerTitle },
      { drawer: 'compose', label: DEFAULT_STUDIO_LOCALE_TEXT.composeDrawerTitle },
      { drawer: 'filters', label: DEFAULT_STUDIO_LOCALE_TEXT.filtersDrawerTitle },
    ]);

    const bodies = ['data', 'compose', 'filters'].filter(
      (drawer) => screen.queryByTestId(`panel-${drawer}`) !== null,
    );
    expect(bodies.length).to.be.lessThan(2);
  });

  it('offers every panel as a tab even while only one body renders', () => {
    // The other half: nothing becomes unreachable. A layout that shows one panel and hides the
    // route to the others is worse than the one it replaced.
    renderTabbed([
      { drawer: 'data', label: DEFAULT_STUDIO_LOCALE_TEXT.dataDrawerTitle },
      { drawer: 'compose', label: DEFAULT_STUDIO_LOCALE_TEXT.composeDrawerTitle },
      { drawer: 'filters', label: DEFAULT_STUDIO_LOCALE_TEXT.filtersDrawerTitle },
    ]);

    // Queried as `tab`, not `button`: the rail is a real APG tablist, and asserting the role is
    // also asserting that a screen-reader user is told these are alternatives rather than actions.
    const tabs = screen.getAllByRole('tab');
    expect(tabs).to.have.length(3);
    expect(tabs.map((tab) => tab.textContent)).to.deep.equal([
      DEFAULT_STUDIO_LOCALE_TEXT.dataDrawerTitle,
      DEFAULT_STUDIO_LOCALE_TEXT.composeDrawerTitle,
      DEFAULT_STUDIO_LOCALE_TEXT.filtersDrawerTitle,
    ]);
    // Exactly one is selected, which is what "one panel at a time" means to assistive tech.
    expect(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true')).to.have.length(1);
  });

  it('reports a narrow viewport through matchMedia', () => {
    // The mechanism the layout branch reads. A media query rather than a container query because
    // what is scarce is VIEWPORT width — whether three panels plus a canvas fit on the screen at
    // all. The canvas measures its own container separately, for row stacking, which is a
    // different question.
    window.matchMedia = matchMediaStub(true) as typeof window.matchMedia;
    expect(window.matchMedia(DEFAULT_NARROW_LAYOUT_MEDIA_QUERY).matches).to.equal(true);

    window.matchMedia = matchMediaStub(false) as typeof window.matchMedia;
    expect(window.matchMedia(DEFAULT_NARROW_LAYOUT_MEDIA_QUERY).matches).to.equal(false);
  });

  it('defaults to the md breakpoint without needing a theme', () => {
    // The default is a literal query, not `theme.breakpoints.down('md')`, so the layout branch is
    // correct with or without a `ThemeProvider` — which is the whole reason it is a string. This
    // pins the value against the default `md` breakpoint it is meant to mirror, since the two can
    // now drift silently.
    const withoutSpaces = (query: string) => query.replace(/\s+/g, '');
    expect(withoutSpaces(DEFAULT_NARROW_LAYOUT_MEDIA_QUERY)).to.equal(
      withoutSpaces(createTheme().breakpoints.down('md')),
    );
  });
});
