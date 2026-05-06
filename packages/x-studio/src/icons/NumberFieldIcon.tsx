import * as React from 'react';
import { PaddedFieldSvg } from './utils';

export function NumberFieldIcon({ size }: { size?: number }) {
  return (
    <PaddedFieldSvg size={size}>
      <g transform="translate(4, 0)">
        {/* vertical bars — spacing = 4 units */}
        <line
          x1="6"
          y1="4.5"
          x2="5.5"
          y2="12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="10"
          y1="4.5"
          x2="9.5"
          y2="12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {/* horizontal bars — spacing = 4 units (matches vertical) */}
        <line
          x1="4"
          y1="6"
          x2="11.5"
          y2="6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="3.75"
          y1="10"
          x2="11.25"
          y2="10"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>
    </PaddedFieldSvg>
  );
}
