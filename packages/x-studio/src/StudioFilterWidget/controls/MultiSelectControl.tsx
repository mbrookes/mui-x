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
          <Tooltip title="Clear filter">
            <Box
              component="span"
              role="button"
              tabIndex={0}
              aria-label="Clear selection filter"
              onClick={onClear}
              onKeyDown={(evt) => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                  onClear();
                }
              }}
              sx={{
                cursor: 'pointer',
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
            return <em style={{ opacity: 0.5 }}>All</em>;
          }
          return `${(sel as string[]).length} selected`;
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
              placeholder="Search…"
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
                aria-label="Select all options"
                onClick={(evt) => {
                  evt.stopPropagation();
                  handleSelectionChange(values);
                }}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' || evt.key === ' ') {
                    handleSelectionChange(values);
                  }
                }}
                sx={{ cursor: 'pointer', color: 'primary.main', fontSize: 12 }}
              >
                Select all
              </Box>
              <Typography variant="caption" color="text.disabled">
                ·
              </Typography>
              <Box
                component="span"
                role="button"
                tabIndex={0}
                aria-label="Clear all selections"
                onClick={(evt) => {
                  evt.stopPropagation();
                  onClear();
                }}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' || evt.key === ' ') {
                    onClear();
                  }
                }}
                sx={{ cursor: 'pointer', color: 'text.secondary', fontSize: 12 }}
              >
                Clear all
              </Box>
            </Stack>
            {onExcludeChange && (
              <Box
                component="span"
                role="button"
                tabIndex={0}
                aria-label={exclude ? 'Switch to include mode' : 'Switch to exclude mode'}
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
                  cursor: 'pointer',
                  fontSize: 12,
                  color: exclude ? 'error.main' : 'text.secondary',
                  mt: 0.5,
                }}
              >
                {exclude ? '⊘ Excluding selected' : 'Exclude selected'}
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
              No options found
            </Typography>
          </MenuItem>
        )}
      </Select>
    </Stack>
  );
}
