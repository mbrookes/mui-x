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
