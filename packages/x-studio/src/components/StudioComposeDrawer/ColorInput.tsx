'use client';
import * as React from 'react';
import { Box, IconButton, TextField } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { ColorSwatch } from './ColorSwatch';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

/** Inline color swatch + text field. Uses native <input type="color"> for the picker. */
export function ColorInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const localeText = useStudioLocaleText();
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <ColorSwatch value={value} onChange={onChange} label={`${label} color picker`} />
      <TextField
        size="small"
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? '#rrggbb'}
        sx={{ flexGrow: 1 }}
        slotProps={{
          htmlInput: { spellCheck: false },
          input: value
            ? {
                endAdornment: (
                  <IconButton
                    size="small"
                    edge="end"
                    aria-label={localeText.colorInputClearAriaLabel(label)}
                    onClick={() => onChange('')}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                ),
              }
            : undefined,
        }}
      />
    </Box>
  );
}
