'use client';
import * as React from 'react';
import { Box } from '@mui/material';
import CreateIcon from '@mui/icons-material/Create';

/** Returns 'white' or 'black' depending on which contrasts better against the hex color. */
function getContrastColor(hex: string): 'white' | 'black' {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) {
    return 'white';
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? 'black' : 'white';
}

/** A circular color swatch button with a centred crayon icon in a contrasting color. */
export function ColorSwatch({
  value,
  onChange,
  label,
  size = 32,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  size?: number;
}) {
  const iconColor = getContrastColor(value || '#ffffff');
  return (
    <Box
      sx={{
        position: 'relative',
        width: size,
        height: size,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Box
        component="input"
        type="color"
        value={value || '#ffffff'}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        sx={{
          width: size,
          height: size,
          p: 0,
          border: 1,
          borderColor: 'divider',
          borderRadius: '50%',
          cursor: 'default',
          display: 'block',
          '&::-webkit-color-swatch-wrapper': { padding: 0 },
          '&::-webkit-color-swatch': { borderRadius: '50%', border: 'none' },
        }}
        aria-label={label ?? 'Color picker'}
      />
      <CreateIcon
        sx={{
          position: 'absolute',
          fontSize: Math.round(size * 0.55),
          color: iconColor,
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
}
