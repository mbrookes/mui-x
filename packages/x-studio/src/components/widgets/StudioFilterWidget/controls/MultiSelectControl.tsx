'use client';
import * as React from 'react';
import {
  Box,
  Checkbox,
  IconButton,
  InputAdornment,
  ListItemText,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import { useStudioLocaleText } from '../../../../internals/StudioUIConfigContext';

/** Reset styles to make a native <button> look like an inline text action. */
const inlineButtonSx = {
  border: 0,
  m: 0,
  p: 0,
  background: 'transparent',
  font: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 12,
  '&:focus-visible': {
    outline: '2px solid',
    outlineColor: 'primary.main',
    outlineOffset: 2,
    borderRadius: 2,
  },
} as const;

export interface StudioFilterMultiSelectControlProps {
  label: string;
  values: string[];
  selected: string[];
  onApply: (v: string[], op?: 'in' | 'not_in') => void;
  onClear: () => void;
  /** Whether the filter is in exclude (NOT IN) mode. @default false */
  exclude?: boolean;
  /**
   * Called when the user toggles include/exclude mode.
   * @param {boolean} exclude Whether the option should be excluded from the selected set.
   */
  onExcludeChange?: (exclude: boolean) => void;
}

export function MultiSelectControl(props: StudioFilterMultiSelectControlProps) {
  const { label, values, selected, onApply, onClear, exclude = false, onExcludeChange } = props;
  const localeText = useStudioLocaleText();
  const [search, setSearch] = React.useState('');
  const isActive = selected.length > 0;

  const filtered = search
    ? values.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
    : values;

  const handleSelectionChange = (newValue: string[]) => {
    if (newValue.length === 0) {
      onClear();
    } else {
      onApply(newValue);
    }
  };

  return (
    <Stack spacing={0.5} role="group" aria-label={label}>
      {isActive && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Tooltip title={localeText.filterWidgetClearAriaLabel}>
            <IconButton
              size="small"
              aria-label={localeText.filterWidgetClearAriaLabel}
              onClick={onClear}
              sx={{ color: 'text.secondary', p: 0.5 }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
      <Select
        multiple
        size="small"
        fullWidth
        value={selected}
        onChange={(evt) => handleSelectionChange(evt.target.value as string[])}
        displayEmpty
        renderValue={(sel) => {
          if ((sel as string[]).length === 0) {
            return <em style={{ opacity: 0.5 }}>{localeText.filterWidgetAllLabel}</em>;
          }
          return localeText.filterWidgetSelectedCount((sel as string[]).length);
        }}
        MenuProps={{
          slotProps: { paper: { sx: { maxHeight: 320 } } },
          autoFocus: false,
        }}
      >
        {/* Search + bulk actions live in a ListSubheader so they are not exposed as
            selectable listbox options (which would break arrow-key navigation and
            announce a bogus option). */}
        <ListSubheader
          disableGutters
          onKeyDown={(evt) => evt.stopPropagation()}
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 1,
            bgcolor: 'background.paper',
            px: 1,
            pb: 0.5,
            lineHeight: 'unset',
          }}
        >
          <Stack spacing={0.5} sx={{ width: '100%' }}>
            <TextField
              size="small"
              fullWidth
              placeholder={localeText.filterSearchValues}
              value={search}
              onChange={(evt) => setSearch(evt.target.value)}
              onClick={(evt) => evt.stopPropagation()}
              slotProps={{
                htmlInput: { 'aria-label': localeText.filterSearchValues },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon sx={{ fontSize: 16 }} />
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Box
                component="button"
                type="button"
                aria-label={localeText.filterWidgetSelectAllLabel}
                onClick={(evt) => {
                  evt.stopPropagation();
                  handleSelectionChange(values);
                }}
                sx={{ ...inlineButtonSx, color: 'primary.main' }}
              >
                {localeText.filterWidgetSelectAllLabel}
              </Box>
              <Typography variant="caption" color="text.disabled" aria-hidden>
                ·
              </Typography>
              <Box
                component="button"
                type="button"
                aria-label={localeText.filterWidgetClearAllLabel}
                onClick={(evt) => {
                  evt.stopPropagation();
                  onClear();
                }}
                sx={{ ...inlineButtonSx, color: 'text.secondary' }}
              >
                {localeText.filterWidgetClearAllLabel}
              </Box>
            </Stack>
            {onExcludeChange && (
              <Box
                component="button"
                type="button"
                aria-label={
                  exclude ? localeText.filterWidgetExcludingLabel : localeText.filterWidgetExcludeLabel
                }
                aria-pressed={exclude}
                onClick={(evt) => {
                  evt.stopPropagation();
                  onExcludeChange(!exclude);
                }}
                sx={{
                  ...inlineButtonSx,
                  alignSelf: 'flex-start',
                  color: exclude ? 'error.main' : 'text.secondary',
                  mt: 0.5,
                }}
              >
                {exclude ? localeText.filterWidgetExcludingLabel : localeText.filterWidgetExcludeLabel}
              </Box>
            )}
          </Stack>
        </ListSubheader>
        {filtered.map((v) => (
          <MenuItem key={v} value={v} dense>
            <Checkbox
              size="small"
              checked={selected.includes(v)}
              sx={{ p: 0.5, mr: 0.5 }}
              slotProps={{ input: { 'aria-label': v } }}
            />
            <ListItemText primary={v} />
          </MenuItem>
        ))}
        {filtered.length === 0 && (
          <MenuItem disabled>
            <Typography variant="caption" color="text.secondary">
              {localeText.filterWidgetNoOptionsLabel}
            </Typography>
          </MenuItem>
        )}
      </Select>
    </Stack>
  );
}
