import * as React from 'react';
import { FieldSvg } from './utils';

export function NumberFieldIcon({ size }: { size?: number }) {
  return (
    <FieldSvg size={size}>
      <line x1="5.5" y1="2.5" x2="4.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11.5" y1="2.5" x2="10.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2.5" y1="10" x2="13.5" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </FieldSvg>
  );
}
