import * as React from 'react';
import { GeneratedFieldSvg } from './utils';

export function NumberFieldGeneratedIcon({ size }: { size?: number }) {
  return (
    <GeneratedFieldSvg size={size}>
      <g transform="translate(4, 0)">
        {/* vertical bars — spacing = 4 units */}
        <line
          x1="6"
          y1="4.5"
          x2="6"
          y2="11.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="10"
          y1="4.5"
          x2="10"
          y2="11.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {/* horizontal bars — spacing = 4 units (matches vertical) */}
        <line
          x1="4.5"
          y1="6"
          x2="11.5"
          y2="6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="4.5"
          y1="10"
          x2="11.5"
          y2="10"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>
    </GeneratedFieldSvg>
  );
}
