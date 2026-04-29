import * as React from 'react';
import { PaddedFieldSvg } from './utils';

export function BooleanFieldIcon({ size }: { size?: number }) {
  return (
    <PaddedFieldSvg size={size}>
      <g transform="translate(4, 0)">
        <rect x="1.5" y="5" width="13" height="6" rx="3" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="10.5" cy="8" r="2.2" fill="currentColor" />
      </g>
    </PaddedFieldSvg>
  );
}
