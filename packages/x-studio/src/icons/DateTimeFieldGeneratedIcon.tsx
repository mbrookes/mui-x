import * as React from 'react';
import { GeneratedFieldSvg } from './utils';

export function DateTimeFieldGeneratedIcon({ size }: { size?: number }) {
  return (
    <GeneratedFieldSvg size={size}>
      <g transform="translate(4, 0)">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
        <line
          x1="8"
          y1="8"
          x2="5.5"
          y2="5.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <line
          x1="8"
          y1="8"
          x2="11"
          y2="8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <circle cx="8" cy="8" r="0.9" fill="currentColor" />
      </g>
    </GeneratedFieldSvg>
  );
}
