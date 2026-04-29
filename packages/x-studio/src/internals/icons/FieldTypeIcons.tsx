import * as React from 'react';

const DEFAULT_SIZE = 16;

function Svg({ size = DEFAULT_SIZE, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      {children}
    </svg>
  );
}

// ── String ────────────────────────────────────────────────────────────────────
// "T" — horizontal top bar + vertical stem

export function StringFieldIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <line x1="3" y1="3.5" x2="13" y2="3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="8" y1="3.5" x2="8" y2="13.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

// ── Number ────────────────────────────────────────────────────────────────────
// "#" — two slanted verticals × two horizontals

export function NumberFieldIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <line x1="5.5" y1="2.5" x2="4.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11.5" y1="2.5" x2="10.5" y2="13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2.5" y1="6.5" x2="13.5" y2="6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2.5" y1="10" x2="13.5" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </Svg>
  );
}

// ── Date ──────────────────────────────────────────────────────────────────────
// Calendar outline with ring hangers and three date dots

export function DateFieldIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="2" y="4.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1.3" />
      <line x1="5" y1="2.5" x2="5" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11" y1="2.5" x2="11" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="5.5" cy="10.5" r="0.9" fill="currentColor" />
      <circle cx="8.5" cy="10.5" r="0.9" fill="currentColor" />
      <circle cx="11.5" cy="10.5" r="0.9" fill="currentColor" />
    </Svg>
  );
}

// ── DateTime ──────────────────────────────────────────────────────────────────
// Clock face — circle with hour and minute hands

export function DateTimeFieldIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <line x1="8" y1="8" x2="5.5" y2="5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="8" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" />
    </Svg>
  );
}

// ── Boolean ───────────────────────────────────────────────────────────────────
// Toggle switch — pill outline with filled knob in "on" position

export function BooleanFieldIcon({ size }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="1.5" y="5" width="13" height="6" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10.5" cy="8" r="2.2" fill="currentColor" />
    </Svg>
  );
}
