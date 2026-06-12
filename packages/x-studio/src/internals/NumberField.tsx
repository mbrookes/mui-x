'use client';
import * as React from 'react';
import { NumberField as BaseNumberField } from '@base-ui/react/number-field';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import OutlinedInput from '@mui/material/OutlinedInput';
import type { SxProps, Theme } from '@mui/material/styles';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { useStudioLocaleText } from './StudioUIConfigContext';

/**
 * Placeholder that signals MUI's FormControl to shrink the label on SSR
 * when a value is already present (muiName is used for FormControl detection).
 */
function SSRInitialFilled(_: BaseNumberField.Root.Props) {
  return null;
}
SSRInitialFilled.muiName = 'Input';

export interface NumberFieldProps extends Omit<
  BaseNumberField.Root.Props,
  'onChange' | 'children'
> {
  label?: React.ReactNode;
  helperText?: React.ReactNode;
  size?: 'small' | 'medium';
  error?: boolean;
  fullWidth?: boolean;
  sx?: SxProps<Theme>;
}

/**
 * An outlined number field built from Base UI `NumberField` primitives, styled
 * to match MUI's outlined `TextField`. Provides increment / decrement buttons
 * in the end adornment slot.
 */
export function NumberField({
  id: idProp,
  label,
  helperText,
  error,
  size = 'medium',
  fullWidth,
  sx,
  ...other
}: NumberFieldProps) {
  const localeText = useStudioLocaleText();
  const generatedId = React.useId();
  const id = idProp ?? generatedId;
  const helperId = `${id}-helper-text`;

  return (
    <BaseNumberField.Root
      {...other}
      render={(props, state) => (
        <FormControl
          size={size}
          ref={props.ref}
          disabled={state.disabled}
          required={state.required}
          error={error}
          fullWidth={fullWidth}
          variant="outlined"
          sx={sx}
        >
          {props.children}
        </FormControl>
      )}
    >
      <SSRInitialFilled {...other} />
      <InputLabel htmlFor={id}>{label}</InputLabel>
      <BaseNumberField.Input
        id={id}
        render={(props, state) => (
          <OutlinedInput
            aria-describedby={helperId}
            label={label}
            inputRef={props.ref}
            value={state.inputValue}
            onBlur={props.onBlur}
            onChange={props.onChange}
            onKeyUp={props.onKeyUp}
            onKeyDown={props.onKeyDown}
            onFocus={props.onFocus}
            slotProps={{ input: props }}
            endAdornment={
              <InputAdornment
                position="end"
                sx={{
                  flexDirection: 'column',
                  maxHeight: 'unset',
                  alignSelf: 'stretch',
                  borderLeft: '1px solid',
                  borderColor: 'divider',
                  ml: 0,
                  '& button': { py: 0, flex: 1, borderRadius: 0.5 },
                }}
              >
                <BaseNumberField.Increment
                  render={
                    <IconButton size={size} aria-label={localeText.numberFieldIncreaseAriaLabel} />
                  }
                >
                  <KeyboardArrowUpIcon fontSize={size} sx={{ transform: 'translateY(2px)' }} />
                </BaseNumberField.Increment>
                <BaseNumberField.Decrement
                  render={
                    <IconButton size={size} aria-label={localeText.numberFieldDecreaseAriaLabel} />
                  }
                >
                  <KeyboardArrowDownIcon fontSize={size} sx={{ transform: 'translateY(-2px)' }} />
                </BaseNumberField.Decrement>
              </InputAdornment>
            }
            sx={{ pr: 0 }}
          />
        )}
      />
      {helperText ? (
        <FormHelperText id={helperId} sx={{ ml: 0 }}>
          {helperText}
        </FormHelperText>
      ) : (
        // Keep the helper-text slot in the DOM so aria-describedby resolves,
        // but give it no height when empty.
        <FormHelperText id={helperId} sx={{ ml: 0, mt: 0, height: 0, overflow: 'hidden' }} />
      )}
    </BaseNumberField.Root>
  );
}
