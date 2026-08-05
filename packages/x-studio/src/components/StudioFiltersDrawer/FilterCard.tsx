'use client';
import * as React from 'react';
import { Box, Collapse, IconButton, Switch, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useStudioLocaleText } from '../../context';

interface FilterCardProps {
  /** Primary label shown in the card header (field name or "Rank by Revenue"). */
  title: string;
  /** Summary text shown in the header when the card is collapsed. */
  summary: string;
  onRemove: () => void;
  children: React.ReactNode;
  /**
   * Whether the card should be expanded. Defaults to `false` (collapsed).
   * Pass `true` for freshly-created filters so the user can immediately
   * configure them; pass `false` (or omit) for filters loaded from a preset
   * or persisted state so the summary is shown by default.
   *
   * Despite the name this is NOT read only at mount: the row recomputes it from live state
   * (an unresolved field, a value that stopped being effective), so a card the user had
   * collapsed re-expands when it flips to `true`. A user collapse is never overridden by a
   * re-render, only by a false → true transition.
   */
  initialExpanded?: boolean;
  /**
   * Whether the filter is currently toggled OFF (`StudioFilterState.disabled`). A disabled
   * filter still exists in the doc and still shows its full configuration, but no data path
   * applies it — so the card is dimmed and the enable switch below reads "off".
   */
  disabled?: boolean;
  /**
   * When provided, renders a switch in the card header that enables / disables the filter.
   * Before this, the ONLY toggle in the product was the quick-filter chip, which renders
   * in view mode only — so a filter disabled from view mode was, in edit mode, an ordinary
   * looking card counted as active with no way to turn it back on and nothing on screen
   * explaining why its widget showed unfiltered data.
   */
  onToggleDisabled?: () => void;
}

/**
 * Collapsible card used by both PageFilterRow and WidgetFilterRow.
 */
export function FilterCard({
  title,
  summary,
  onRemove,
  children,
  initialExpanded = false,
  disabled = false,
  onToggleDisabled,
}: FilterCardProps) {
  const [expanded, setExpanded] = React.useState(initialExpanded);
  const regionId = React.useId();
  const localeText = useStudioLocaleText();

  // `initialExpanded` used to be a mount-only seed, so a card that was already collapsed when
  // its field STOPPED resolving (the source reloaded with the column renamed/dropped) kept the
  // `UnresolvedFieldAlert` hidden inside the collapsed body — the one banner whose entire point
  // is that it must be seen without the user first suspecting the filter. Re-expand on the
  // false → true transition; a true → false transition leaves the user's own state alone.
  const prevInitialExpandedRef = React.useRef(initialExpanded);
  if (prevInitialExpandedRef.current !== initialExpanded) {
    prevInitialExpandedRef.current = initialExpanded;
    if (initialExpanded && !expanded) {
      setExpanded(true);
    }
  }

  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        // Dimming is a redundant cue only — the switch below carries the state accessibly.
        ...(disabled && { borderStyle: 'dashed', backgroundColor: 'action.hover' }),
      }}
    >
      {/* Header row */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 0.5,
          py: 0.5,
        }}
      >
        <Box
          component="button"
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-controls={regionId}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            flexGrow: 1,
            minWidth: 0,
            border: 0,
            m: 0,
            p: 0,
            background: 'transparent',
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            userSelect: 'none',
            borderRadius: 1,
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          {/* Decorative chevron — rendered as a span so it is not a nested button. */}
          <IconButton
            component="span"
            size="small"
            tabIndex={-1}
            aria-hidden
            sx={{ flexShrink: 0, pointerEvents: 'none' }}
          >
            {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
          </IconButton>

          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              component="span"
              noWrap
              color={disabled ? 'text.disabled' : undefined}
              sx={{ display: 'block', fontWeight: 'medium', lineHeight: 1.3 }}
            >
              {title}
            </Typography>
            {!expanded && (
              <Typography
                variant="caption"
                component="span"
                color={disabled ? 'text.disabled' : 'text.secondary'}
                sx={{ display: 'block' }}
              >
                {summary}
              </Typography>
            )}
          </Box>
        </Box>

        {/* Sits OUTSIDE the expand button above — a switch nested in a button is neither
            operable nor announceable. Its accessible name is the card title, so a screen
            reader reads "<field>, switch, on/off"; the tooltip carries the action wording. */}
        {onToggleDisabled && (
          <Tooltip
            title={
              disabled
                ? localeText.quickFilterBarEnableFilter
                : localeText.quickFilterBarDisableFilter
            }
          >
            <Switch
              size="small"
              checked={!disabled}
              onChange={onToggleDisabled}
              slotProps={{ input: { 'aria-label': title } }}
              sx={{ flexShrink: 0 }}
            />
          </Tooltip>
        )}

        <IconButton
          size="small"
          onClick={onRemove}
          aria-label={localeText.filterRemoveAriaLabel}
          sx={{ flexShrink: 0 }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Body */}
      <Collapse in={expanded}>
        <Box id={regionId} sx={disabled ? { opacity: 0.6 } : undefined}>
          {children}
        </Box>
      </Collapse>
    </Box>
  );
}
