'use client';
import * as React from 'react';
import {
  Box,
  Checkbox,
  InputAdornment,
  ListItemText,
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
            <Box
              component="span"
              role="button"
              tabIndex={0}
              aria-label={localeText.filterWidgetClearAriaLabel}
              onClick={onClear}
              onKeyDown={(evt) => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                  onClear();
                }
              }}
              sx={{
                cursor: 'default',
                color: 'text.secondary',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </Box>
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
        {/* Search + bulk actions inside the dropdown */}
        <MenuItem
          disableRipple
          onKeyDown={(evt) => evt.stopPropagation()}
          sx={{ position: 'sticky', top: 0, zIndex: 1, bgcolor: 'background.paper', pb: 0.5 }}
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
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon sx={{ fontSize: 16 }} />
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Stack direction="row" spacing={1}>
              <Box
                component="span"
                role="button"
                tabIndex={0}
                aria-label={localeText.filterWidgetSelectAllLabel}
                onClick={(evt) => {
                  evt.stopPropagation();
                  handleSelectionChange(values);
                }}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' || evt.key === ' ') {
                    handleSelectionChange(values);
                  }
                }}
                sx={{ cursor: 'default', color: 'primary.main', fontSize: 12 }}
              >
                {localeText.filterWidgetSelectAllLabel}
              </Box>
              <Typography variant="caption" color="text.disabled">
                ·
              </Typography>
              <Box
                component="span"
                role="button"
                tabIndex={0}
                aria-label={localeText.filterWidgetClearAllLabel}
                onClick={(evt) => {
                  evt.stopPropagation();
                  onClear();
                }}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' || evt.key === ' ') {
                    onClear();
                  }
                }}
                sx={{ cursor: 'default', color: 'text.secondary', fontSize: 12 }}
              >
                {localeText.filterWidgetClearAllLabel}
              </Box>
            </Stack>
            {onExcludeChange && (
              <Box
                component="span"
                role="button"
                tabIndex={0}
                aria-label={exclude ? localeText.filterWidgetExcludingLabel : localeText.filterWidgetExcludeLabel}
                aria-pressed={exclude}
                onClick={(evt) => {
                  evt.stopPropagation();
                  onExcludeChange(!exclude);
                }}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' || evt.key === ' ') {
                    onExcludeChange(!exclude);
                  }
                }}
                sx={{
                  cursor: 'default',
                  fontSize: 12,
                  color: exclude ? 'error.main' : 'text.secondary',
                  mt: 0.5,
                }}
              >
                {exclude ? localeText.filterWidgetExcludingLabel : localeText.filterWidgetExcludeLabel}
              </Box>
            )}
          </Stack>
        </MenuItem>
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
