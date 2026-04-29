import * as React from 'react';
import { GeneratedFieldSvg } from './utils';

export function NumberFieldGeneratedIcon({ size }: { size?: number }) {
  return (
    <GeneratedFieldSvg size={size}>
      <g transform="translate(4, 0)">
        <line x1="5.5" y1="2.5" x2="4.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="11.5" y1="2.5" x2="10.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="2.5" y1="10" x2="13.5" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </g>
    </GeneratedFieldSvg>
  );
}
