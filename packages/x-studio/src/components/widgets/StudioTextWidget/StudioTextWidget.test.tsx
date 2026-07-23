import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type {
  StudioWidgetConfig,
  StudioWidgetConfigForKind,
  StudioWidgetOf,
} from '../../../models';
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
    render(<StudioTextWidget widget={makeWidget({ textBody: '   spaced   ' })} pageId="page-1" />);
    expect(screen.getByText('spaced')).not.toBe(null);
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
    render(
      <StudioTextWidget
        widget={
          makeWidget({
            textBody: 'Body copy',
            textBodyFontSize: 'evil' as unknown as number,
          }) as ReturnType<typeof makeWidget>
        }
        pageId="page-1"
      />,
    );
    // No thrown error and the body text still renders — the invalid font size is simply
    // dropped rather than propagated into `sx`.
    expect(screen.getByText('Body copy')).not.toBe(null);
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
