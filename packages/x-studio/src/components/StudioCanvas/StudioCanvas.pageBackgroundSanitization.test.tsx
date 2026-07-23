import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioCustomWidgetDef, StudioWidget, StudioWidgetConfig } from '../../models';
import { StudioCanvas } from './StudioCanvas';

const { render } = createRenderer();

/**
 * Finding 1 (Tier1): `activePage.theme.pageBackground` used to be interpolated straight
 * into the canvas root's `sx.backgroundColor` with no validation, while every OTHER
 * `StudioPageTheme` field (`cardBorderColor`, `cardBackground`, `cardRadius`,
 * `cardPadding`, `cardBorderWidth`) was already sanitized via `sanitizeCssColor`/
 * `sanitizeFiniteNumber` in `StudioWidgetCard.tsx`. `pageBackground` is doc-authored
 * (`StudioPage.theme`), reachable via `loadSerializedState(unknown)` or the AI
 * `apply_bulk_update` tool call, and Emotion does not escape interpolated `sx` values —
 * a hostile string like `"red;} body{...}"` would inject arbitrary CSS into the whole
 * canvas.
 */

function DummyWidget() {
  return <div>widget content</div>;
}

const DUMMY_WIDGET_DEF: StudioCustomWidgetDef = {
  kind: 'dummy-pagebg',
  label: 'Dummy',
  component: DummyWidget,
};

function makeWidget(id: string): StudioWidget {
  return { id, kind: 'dummy-pagebg', title: id, config: {} as StudioWidgetConfig };
}

function setup(pageBackground: unknown) {
  const { wrapper } = createStudioHarness({
    initialState: {
      doc: {
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'Page 1',
            widgetRows: [['w1']],
            theme: { pageBackground } as never,
          },
        },
        widgets: { w1: makeWidget('w1') },
      },
    },
    providerProps: { customWidgets: [DUMMY_WIDGET_DEF] },
  });
  const { container } = render(<StudioCanvas />, { wrapper });
  return container.firstElementChild as HTMLElement;
}

describe('StudioCanvas pageBackground sanitization (finding 1)', () => {
  it('applies a valid CSS color to the canvas background', () => {
    const canvasRoot = setup('#ff0000');
    expect(getComputedStyle(canvasRoot).backgroundColor).toBe('rgb(255, 0, 0)');
  });

  it('falls back to unset instead of propagating a CSS-injection payload', () => {
    const injected = setup('red;} .MuiCard-root{background:url(https://evil/leak)');
    const clean = setup(undefined);
    // The hostile value must not be applied — computed background matches the
    // no-theme default rather than resolving to the attacker's color/rule.
    expect(getComputedStyle(injected).backgroundColor).toBe(
      getComputedStyle(clean).backgroundColor,
    );
    // Nothing on the page carries the raw payload string into a stylesheet.
    const styleText = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules).map((rule) => rule.cssText);
        } catch {
          return [];
        }
      })
      .join('\n');
    expect(styleText).not.toContain('evil/leak');
  });
});
