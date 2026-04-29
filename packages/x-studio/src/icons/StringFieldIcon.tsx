import * as React from 'react';
import { PaddedFieldSvg } from './utils';

export function StringFieldIcon({ size }: { size?: number }) {
  return (
    <PaddedFieldSvg size={size}>
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
    </PaddedFieldSvg>
  );
}
