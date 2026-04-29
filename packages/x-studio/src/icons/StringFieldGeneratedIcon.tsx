import * as React from 'react';
import { GeneratedFieldSvg } from './utils';

export function StringFieldGeneratedIcon({ size }: { size?: number }) {
  return (
    <GeneratedFieldSvg size={size}>
      <g transform="translate(4, 0)">
        <line x1="3" y1="3.5" x2="13" y2="3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <line x1="8" y1="3.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </g>
    </GeneratedFieldSvg>
  );
}
