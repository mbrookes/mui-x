import * as React from 'react';
import { createRenderer, screen, waitFor } from '@mui/internal-test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  StudioWidgetConfig,
  StudioWidgetConfigForKind,
  StudioWidgetOf,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import {
  StudioUIConfigContext,
  DEFAULT_STUDIO_LOCALE_TEXT,
} from '../../../internals/StudioUIConfigContext';
import { StudioTextWidget } from './StudioTextWidget';

const { render } = createRenderer();

function makeWidget(config: Partial<StudioWidgetConfig>): StudioWidgetOf<'text'> {
  return {
    id: 't1',
    kind: 'text',
    title: 'Text',
    config: config as StudioWidgetConfigForKind<'text'>,
  };
}

describe('StudioTextWidget', () => {
  it('renders the subtitle and body text', () => {
    render(
      <StudioTextWidget
        widget={makeWidget({ textSubtitle: 'Heading', textBody: 'Body copy' })}
        pageId="page-1"
      />,
    );
    expect(screen.getByText('Heading')).not.toBe(null);
    expect(screen.getByText('Body copy')).not.toBe(null);
  });

  it('trims surrounding whitespace', () => {
    const { container } = render(
      <StudioTextWidget widget={makeWidget({ textBody: '   spaced   ' })} pageId="page-1" />,
    );
    // Asserted on `textContent`, not via `getByText`: Testing Library's DEFAULT matcher
    // normalizer trims and collapses whitespace BEFORE comparing, so
    // `getByText('spaced')` passed whether or not the component trimmed anything —
    // deleting the trim left the test green. The trimming is genuinely user-visible: the
    // body renders with `whiteSpace: 'pre-wrap'` (`StudioTextWidget.tsx`), so untrimmed
    // leading/trailing spaces are painted rather than collapsed by the browser.
    expect(container.textContent).toBe('spaced');
  });

  it('renders only the body when no subtitle is set', () => {
    render(<StudioTextWidget widget={makeWidget({ textBody: 'Only body' })} pageId="page-1" />);
    expect(screen.getByText('Only body')).not.toBe(null);
  });

  it('renders nothing when both subtitle and body are empty', () => {
    const { container } = render(
      <StudioTextWidget
        widget={makeWidget({ textSubtitle: '   ', textBody: '' })}
        pageId="page-1"
      />,
    );
    expect(container.firstChild).toBe(null);
  });
});

// The AI branch is the route by which LLM-authored markdown reaches the DOM. `renderMarkdown`
// itself is pinned in `renderMarkdown.test.tsx`; what THIS block pins is that the widget still
// routes AI output THROUGH it — replacing `{renderMarkdown(markdown)}` with `{markdown}` in
// `TextWidgetAIContent` is otherwise invisible, which is the same "guard present, call site
// unobserved" shape as the rest of this file.
describe('StudioTextWidget AI markdown rendering', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // `useTextWidgetAI` memoizes generated markdown in `localStorage` keyed by widget id +
    // prompt hash, and that store outlives a test. Without this, the second test in this
    // block replayed the FIRST test's markdown and never issued a fetch at all.
    window.localStorage.clear();
  });

  function mockAiResponse(markdown: string) {
    const sse = new TextEncoder().encode(
      [{ type: 'text-delta', delta: markdown }, { type: 'finish' }]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    );
    // A fresh single-use `ReadableStream` PER CALL: the hook's effect can run more than once
    // (mount/effect re-entry), and a plain `mockResolvedValue` would hand the same
    // already-locked stream to the second call — the same hazard `mockFetchSequence` in
    // `useTextWidgetAI.test.tsx` exists to avoid.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        ok: true,
        body: new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(sse);
            ctrl.close();
          },
        }),
      })),
    );
  }

  function renderAiWidget(markdown: string, prompt: string) {
    mockAiResponse(markdown);
    const { wrapper: StudioWrapper } = createStudioHarness();
    const uiConfigValue = {
      tableSourceMode: 'explicit' as const,
      featureFlags: {},
      localeText: DEFAULT_STUDIO_LOCALE_TEXT,
      aiConfig: { endpoint: 'https://fake.test/api/ai' },
    };
    function wrapper(props: { children?: React.ReactNode }) {
      return (
        <StudioWrapper>
          <StudioUIConfigContext.Provider value={uiConfigValue}>
            {props.children}
          </StudioUIConfigContext.Provider>
        </StudioWrapper>
      );
    }
    return render(
      <StudioTextWidget
        widget={makeWidget({ textAiEnabled: true, textBody: prompt })}
        pageId="page-1"
      />,
      { wrapper },
    );
  }

  it('renders AI-produced markdown as elements rather than raw text', async () => {
    const { container } = renderAiWidget('Revenue is **up** sharply.', 'Summarize revenue');

    await waitFor(() => {
      expect(container.querySelector('strong')).not.toBe(null);
    });
    expect(container.querySelector('strong')!.textContent).toBe('up');
  });

  it('sanitizes AI-produced markdown: a javascript: link and a remote image are defanged', async () => {
    const { container } = renderAiWidget(
      'See [click](javascript:alert(1)) and ![x](https://attacker.example/pixel.png)',
      'Summarize links',
    );

    await waitFor(() => {
      expect(container.querySelector('a')).not.toBe(null);
    });
    expect(container.querySelector('a')!.getAttribute('href')).toBe(null);
    expect(container.querySelector('img')!.getAttribute('src')).toBe(null);
    expect(container.innerHTML).not.toContain('javascript:');
    expect(container.innerHTML).not.toContain('attacker.example');
  });
});

// Finding 1: `config.textBodyColor`/`textSubtitleColor`/`textBodyFontFamily`/
// `textBodyFontSize` (and their title/subtitle siblings) are doc-authored values reachable
// via `loadSerializedState(data: unknown)` (a hostile serialized dashboard) or the AI
// `update_widget` tool call. They are interpolated into an Emotion `sx` prop, which does
// not escape property values, so an unvalidated string could inject arbitrary CSS rules.
describe('StudioTextWidget CSS value validation (finding 1)', () => {
  const cssInjectionPayload = 'serif;} .MuiCard-root{background:url(https://evil/leak)';

  it('drops a CSS-injecting textBodyFontFamily instead of interpolating it verbatim', () => {
    render(
      <StudioTextWidget
        widget={makeWidget({ textBody: 'Body copy', textBodyFontFamily: cssInjectionPayload })}
        pageId="page-1"
      />,
    );
    expect(screen.getByText('Body copy')).not.toBe(null);
    // The hostile string must never reach the DOM/stylesheet — the malicious selector/rule
    // text must not appear anywhere in the rendered document.
    expect(document.documentElement.outerHTML).not.toContain(cssInjectionPayload);
    expect(document.documentElement.outerHTML).not.toContain('.MuiCard-root{background:url');
  });

  it('drops a CSS-injecting textBodyColor instead of interpolating it verbatim', () => {
    render(
      <StudioTextWidget
        widget={makeWidget({
          textBody: 'Body copy',
          textBodyColor: 'red; } .evil{color:blue',
        })}
        pageId="page-1"
      />,
    );
    expect(screen.getByText('Body copy')).not.toBe(null);
    expect(document.documentElement.outerHTML).not.toContain('.evil{color:blue');
  });

  it('drops a CSS-injecting textSubtitleColor instead of interpolating it verbatim', () => {
    render(
      <StudioTextWidget
        widget={makeWidget({
          textSubtitle: 'Heading',
          textSubtitleColor: 'red;}body{display:none',
        })}
        pageId="page-1"
      />,
    );
    expect(screen.getByText('Heading')).not.toBe(null);
    expect(document.documentElement.outerHTML).not.toContain('body{display:none');
  });

  it('accepts a valid literal CSS font-family stack', () => {
    render(
      <StudioTextWidget
        widget={makeWidget({
          textBody: 'Body copy',
          textBodyFontFamily: 'Fraunces, "Inter Tight", serif',
        })}
        pageId="page-1"
      />,
    );
    expect(document.documentElement.outerHTML).toContain('Fraunces');
  });

  it('accepts a valid hex color', () => {
    render(
      <StudioTextWidget
        widget={makeWidget({ textBody: 'Body copy', textBodyColor: '#ff8800' })}
        pageId="page-1"
      />,
    );
    expect(document.documentElement.outerHTML.toLowerCase()).toContain('ff8800');
  });

  it('falls back to the theme default for a non-numeric textBodyFontSize', () => {
    // A CSS-injecting payload rather than a bland `'evil'`: the old test asserted only
    // that the body still rendered, which stayed green with `sanitizeFontSize` deleted
    // entirely. Assert what its siblings in this describe assert — that the payload never
    // reaches the DOM/stylesheet at all.
    const fontSizeInjectionPayload = '12px;} .MuiCard-root{background:url(https://evil/leak)';
    render(
      <StudioTextWidget
        widget={
          makeWidget({
            textBody: 'Body copy',
            textBodyFontSize: fontSizeInjectionPayload as unknown as number,
          }) as ReturnType<typeof makeWidget>
        }
        pageId="page-1"
      />,
    );
    // No thrown error and the body text still renders — the invalid font size is simply
    // dropped rather than propagated into `sx`.
    expect(screen.getByText('Body copy')).not.toBe(null);
    expect(document.documentElement.outerHTML).not.toContain(fontSizeInjectionPayload);
    expect(document.documentElement.outerHTML).not.toContain('.MuiCard-root{background:url');
  });
});

// Finding 3: `config.textSubtitleAlign` / `config.textBodyAlign` used to be interpolated
// into `sx.textAlign` unvalidated, in the very file whose colors/sizes/fonts were fixed
// in the prior iteration (finding 1, above).
describe('StudioTextWidget align sanitization (finding 3)', () => {
  it('applies a valid textBodyAlign / textSubtitleAlign value', () => {
    render(
      <StudioTextWidget
        widget={makeWidget({
          textSubtitle: 'Heading',
          textSubtitleAlign: 'center',
          textBody: 'Body copy',
          textBodyAlign: 'right',
        })}
        pageId="page-1"
      />,
    );
    expect(getComputedStyle(screen.getByText('Heading')).textAlign).toBe('center');
    expect(getComputedStyle(screen.getByText('Body copy')).textAlign).toBe('right');
  });

  it('rejects an invalid textBodyAlign/textSubtitleAlign value instead of propagating it', () => {
    const cssInjectionPayload = 'left; } .evil{background:url(https://evil/leak)';
    render(
      <StudioTextWidget
        widget={
          makeWidget({
            textSubtitle: 'Heading',
            textSubtitleAlign: cssInjectionPayload as unknown as 'left' | 'center' | 'right',
            textBody: 'Body copy',
            textBodyAlign: cssInjectionPayload as unknown as 'left' | 'center' | 'right',
          }) as ReturnType<typeof makeWidget>
        }
        pageId="page-1"
      />,
    );
    expect(screen.getByText('Heading')).not.toBe(null);
    expect(screen.getByText('Body copy')).not.toBe(null);
    expect(document.documentElement.outerHTML).not.toContain(cssInjectionPayload);
    expect(document.documentElement.outerHTML).not.toContain('.evil{background:url');
  });
});
