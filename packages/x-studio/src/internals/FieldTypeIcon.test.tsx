import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { FieldTypeIcon } from './FieldTypeIcon';
import type { FieldType } from './FieldTypeIcon';

const { render } = createRenderer();

describe('FieldTypeIcon', () => {
  it('renders the localized label for a known field type', () => {
    render(<FieldTypeIcon type="number" />);
    expect(screen.getByRole('img', { name: 'Number' })).not.toBe(null);
  });

  // Architecture review finding (Tier2): `type` is doc-authored (a persisted-doc/
  // AI-authored field `type`), so an unguarded `typeLabels[type] ?? type` bracket lookup
  // that resolves an inherited `Object.prototype` member (e.g. `type: 'constructor'`)
  // would silently surface the inherited function's string representation as the
  // accessible label instead of falling through to the raw type string.
  it('falls back to the raw type string when `type` collides with an Object.prototype member', () => {
    render(<FieldTypeIcon type={'constructor' as FieldType} />);
    expect(screen.getByRole('img', { name: 'constructor' })).not.toBe(null);
    expect(screen.queryByRole('img', { name: /function/i })).toBe(null);
  });
});
