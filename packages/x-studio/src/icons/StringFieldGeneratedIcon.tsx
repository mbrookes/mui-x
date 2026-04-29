import * as React from 'react';
import { GeneratedFieldSvg } from './utils';

export function StringFieldGeneratedIcon({ size }: { size?: number }) {
  return (
    <GeneratedFieldSvg size={size}>
      <g transform="translate(4, 0)">
        <text
          x="0.5"
          y="11.5"
          fontSize="8"
          fontFamily="sans-serif"
          fontWeight="700"
          fill="currentColor"
          letterSpacing="-0.2"
        >
          Abc
        </text>
      </g>
    </GeneratedFieldSvg>
  );
}
