'use client';
import * as React from 'react';
import { useTheme } from '@mui/material/styles';

export interface StudioWordmarkProps {
  /** Height of the wordmark in px. Width scales proportionally. @default 28 */
  height?: number;
}

/**
 * MUI X Studio wordmark — the MUI X icon mark followed by the "MUI X Studio" logotype.
 * Automatically adapts text colour to the current MUI theme mode (light / dark).
 */
export function StudioWordmark({ height = 28 }: StudioWordmarkProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  // Proportional width for the 150×32 viewBox
  const width = Math.round((height * 150) / 32);

  const muiXColor = isDark ? '#ffffff' : '#1C2025';
  const studioColor = '#0079f5';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 150 32"
      width={width}
      height={height}
      fill="none"
      role="img"
      aria-label="MUI X Studio"
    >
      {/* MUI X icon mark — paths from the official favicon, scaled to 24×24 in a 32px-tall canvas */}
      <svg x={0} y={4} width={24} height={24} viewBox="0 0 36 36" fill="none">
        <path
          fill={studioColor}
          d="M12.28 9.51 1.45 3.26a.3.3 0 0 0-.45.26v16.84q0 .16.15.26l4.16 2.43a.3.3 0 0 0 .45-.26V11.64c0-.09.1-.15.18-.1l6.34 3.6c.37.22.83.22 1.2 0l6.2-3.6c.08-.05.18.01.18.1v5.55q-.01.33-.29.52l-6.17 3.76a.3.3 0 0 0-.14.26v5.48q0 .16.14.25l8.2 5.15c.38.24.86.25 1.24.02l10.57-6.24c.37-.21.59-.6.59-1.03V14.54a.3.3 0 0 0-.45-.26l-3.72 2.23c-.36.21-.58.6-.58 1.02v5.56q0 .16-.15.26l-6.27 3.67a1.2 1.2 0 0 1-1.22 0l-3.9-2.31a.18.18 0 0 1 0-.3l6.37-4.18c.33-.22.54-.6.54-1V3.53a.3.3 0 0 0-.45-.27L13.48 9.51a1.2 1.2 0 0 1-1.2 0"
        />
        <path
          fill={studioColor}
          d="M34 3.98v3.87c0 .42-.21.8-.57 1.02l-3.69 2.29a.3.3 0 0 1-.45-.26V6.85c0-.43.23-.83.6-1.04l3.66-2.09a.3.3 0 0 1 .45.26"
        />
      </svg>

      {/* Logotype */}
      <text
        x={32}
        y={22}
        fontFamily="'General Sans', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize={17}
        letterSpacing="-0.2"
      >
        <tspan fontWeight={700} fill={muiXColor}>
          MUI X
        </tspan>
        <tspan fontWeight={400} fill={studioColor}>
          {' '}Studio
        </tspan>
      </text>
    </svg>
  );
}
