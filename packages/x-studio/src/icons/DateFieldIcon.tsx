import * as React from 'react';
import { FieldSvg } from './utils';

export function DateFieldIcon({ size }: { size?: number }) {
  return (
    <FieldSvg size={size}>
      <rect x="2" y="4.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.3" />
      <line x1="5" y1="2.5" x2="5" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11" y1="2.5" x2="11" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="5.5" cy="10.5" r="0.9" fill="currentColor" />
      <circle cx="8.5" cy="10.5" r="0.9" fill="currentColor" />
      <circle cx="11.5" cy="10.5" r="0.9" fill="currentColor" />
    </FieldSvg>
  );
}
