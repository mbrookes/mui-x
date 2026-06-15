import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../../models';
import { StudioTextWidget } from './StudioTextWidget';

const { render } = createRenderer();

function makeWidget(config: Partial<StudioWidgetConfig>): StudioWidget {
  return { id: 't1', kind: 'text', title: 'Text', config: config as StudioWidgetConfig };
}

describe('StudioTextWidget', () => {
  it('renders the subtitle and body text', () => {
    render(
      <StudioTextWidget widget={makeWidget({ textSubtitle: 'Heading', textBody: 'Body copy' })} />,
    );
    expect(screen.getByText('Heading')).not.toBe(null);
    expect(screen.getByText('Body copy')).not.toBe(null);
  });

  it('trims surrounding whitespace', () => {
    render(<StudioTextWidget widget={makeWidget({ textBody: '   spaced   ' })} />);
    expect(screen.getByText('spaced')).not.toBe(null);
  });

  it('renders only the body when no subtitle is set', () => {
    render(<StudioTextWidget widget={makeWidget({ textBody: 'Only body' })} />);
    expect(screen.getByText('Only body')).not.toBe(null);
  });

  it('renders nothing when both subtitle and body are empty', () => {
    const { container } = render(
      <StudioTextWidget widget={makeWidget({ textSubtitle: '   ', textBody: '' })} />,
    );
    expect(container.firstChild).toBe(null);
  });
});
