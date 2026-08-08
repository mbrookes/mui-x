import * as React from 'react';
import { act, createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import { StudioLiveRegionProvider, useStudioAnnounce } from '../../internals/StudioLiveRegion';
import { CollapsibleSection } from '../../internals/CollapsibleSection';

const { render } = createRenderer();

/**
 * The announcement and structure half of AG_STUDIO_GAP_ANALYSIS XS-A11Y-002.
 *
 * The live region and several announcements already existed (panel open/close, widget added,
 * widget moved, keyboard resize). What was missing were the two state changes that move no focus
 * and had no other signal — a mode switch and a widget deletion — plus the grouping that gives a
 * filter row its section's name.
 *
 * `StudioContent` itself is not rendered here: it pulls in the whole canvas, every drawer and the
 * chart packages, which makes a test about four strings cost seconds and fail for unrelated
 * reasons. The behaviours are asserted against the primitives they are built on.
 */

function Announcer({ message }: { message: string }) {
  const announce = useStudioAnnounce();
  React.useEffect(() => {
    announce(message);
  }, [announce, message]);
  return null;
}

describe('Studio live region', () => {
  it('posts to a polite region rather than an assertive one', async () => {
    // Politeness is the whole reason these are safe to add. An assertive region interrupts
    // whatever the user is currently hearing, which for a mode switch or a deletion — neither of
    // which is an error — is worse than staying silent.
    vi.useFakeTimers();
    try {
      render(
        <StudioLiveRegionProvider>
          <Announcer message="Widget deleted" />
        </StudioLiveRegionProvider>,
      );
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      const region = document.querySelector('[aria-live]');
      expect(region?.getAttribute('aria-live')).to.equal('polite');
      expect(region?.textContent).to.equal('Widget deleted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-announces an identical repeat message', async () => {
    // Deleting two widgets in a row produces the same string twice. A live region only speaks on a
    // DOM change, so without the clear-then-set the second deletion is silent — and "did that
    // work?" is exactly the question the announcement exists to answer.
    vi.useFakeTimers();
    try {
      function Repeater() {
        const announce = useStudioAnnounce();
        React.useEffect(() => {
          announce('Widget deleted');
          announce('Widget deleted');
        }, [announce]);
        return null;
      }
      render(
        <StudioLiveRegionProvider>
          <Repeater />
        </StudioLiveRegionProvider>,
      );
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(document.querySelector('[aria-live]')?.textContent).to.equal('Widget deleted');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Studio announcement vocabulary', () => {
  it('has a token for every state change that moves no focus', () => {
    // The gap was not a missing mechanism — the live region already existed and four things already
    // used it. It was that the two largest state changes had nothing to say.
    expect(DEFAULT_STUDIO_LOCALE_TEXT.canvasWidgetRemovedAnnouncement).to.be.a('string');
    expect(DEFAULT_STUDIO_LOCALE_TEXT.modeChangedAnnouncement('edit mode')).to.contain('edit mode');
    expect(DEFAULT_STUDIO_LOCALE_TEXT.modeEditLabel).to.be.a('string');
    expect(DEFAULT_STUDIO_LOCALE_TEXT.modeViewLabel).to.be.a('string');
  });

  it('names the mode in the announcement rather than just saying it changed', () => {
    // "Mode changed" tells a user something happened and not what, which for the one control that
    // adds or removes every authoring affordance is the least useful half of the message.
    const edit = DEFAULT_STUDIO_LOCALE_TEXT.modeChangedAnnouncement(
      DEFAULT_STUDIO_LOCALE_TEXT.modeEditLabel,
    );
    const view = DEFAULT_STUDIO_LOCALE_TEXT.modeChangedAnnouncement(
      DEFAULT_STUDIO_LOCALE_TEXT.modeViewLabel,
    );
    expect(edit).to.not.equal(view);
  });
});

describe('<CollapsibleSection /> grouping', () => {
  it('exposes its body as a group named by its own heading', () => {
    // The fix for "filter rows are not linked to their section headers". A `role="group"` +
    // `aria-labelledby` announces the section once on entry; the obvious alternative — an
    // `aria-describedby` on every row — repeats the section name on each one AND reads it after
    // the row's own name, which is backwards.
    render(
      <CollapsibleSection title="Page filters">
        <button type="button">Region</button>
      </CollapsibleSection>,
    );

    const group = screen.getByRole('group', { name: 'Page filters' });
    expect(group).to.not.equal(null);
    expect(group.contains(screen.getByRole('button', { name: 'Region' }))).to.equal(true);
  });

  it('gives each instance its own label id', () => {
    // `aria-labelledby` is an IDREF. Two sections sharing a literal id would both resolve to
    // whichever heading the document happened to contain first, so every group would claim the
    // same name.
    render(
      <React.Fragment>
        <CollapsibleSection title="Page filters">
          <span>a</span>
        </CollapsibleSection>
        <CollapsibleSection title="Widget filters">
          <span>b</span>
        </CollapsibleSection>
      </React.Fragment>,
    );

    expect(screen.getByRole('group', { name: 'Page filters' })).to.not.equal(null);
    expect(screen.getByRole('group', { name: 'Widget filters' })).to.not.equal(null);
  });
});
