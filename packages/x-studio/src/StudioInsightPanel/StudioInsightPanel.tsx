'use client';
import * as React from 'react';
import { Box, CircularProgress, IconButton, Paper, Tooltip, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { StudioInsightOptions, StudioInsightResult } from '../StudioChatPanel/generateInsight';

export interface StudioInsightPanelProps {
  /** The generated insight, or null if loading/not yet generated. */
  insight: StudioInsightResult | null;
  /** True while the insight is being generated. */
  loading: boolean;
  /** Error message if generation failed. */
  error: string | null;
  /** Called when the user clicks the close button. */
  onClose: () => void;
  /**
   * Called when the user wants to regenerate (type selection or just refresh).
   * @param {StudioInsightOptions['type']} type - The insight type to generate.
   */
  onRegenerate: (type: StudioInsightOptions['type']) => void;
  /** Active insight type. */
  activeType: StudioInsightOptions['type'];
  /** When true, the forecast option is shown. */
  showForecast?: boolean;
}

const TYPE_LABELS: Record<StudioInsightOptions['type'], string> = {
  summary: 'Summary',
  analysis: 'Analysis',
  forecast: 'Forecast',
  anomaly: 'Anomaly Explanation',
};

export function StudioInsightPanel(props: StudioInsightPanelProps) {
  const {
    insight,
    loading,
    error,
    onClose,
    onRegenerate,
    activeType,
    showForecast = false,
  } = props;

  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(() => {
    if (!insight?.text) {
      return;
    }
    navigator.clipboard.writeText(insight.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [insight?.text]);

  const types: StudioInsightOptions['type'][] = showForecast
    ? ['summary', 'analysis', 'forecast']
    : ['summary', 'analysis'];

  return (
    <Paper
      elevation={3}
      sx={{
        position: 'absolute',
        bottom: 8,
        left: 8,
        right: 8,
        zIndex: 10,
        borderRadius: 1,
        p: 1.5,
        maxHeight: '60%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <AutoAwesomeIcon sx={{ fontSize: 16, color: 'primary.main' }} />
        <Typography variant="caption" sx={{ flex: 1, fontWeight: 600 }}>
          AI Insight
        </Typography>
        {/* Type switcher */}
        <Box sx={{ display: 'flex', gap: 0.25 }}>
          {types.map((t) => (
            <Box
              key={t}
              component="button"
              onClick={() => onRegenerate(t)}
              sx={{
                border: 1,
                borderColor: activeType === t ? 'primary.main' : 'divider',
                bgcolor: activeType === t ? 'primary.main' : 'transparent',
                color: activeType === t ? 'primary.contrastText' : 'text.secondary',
                borderRadius: 0.5,
                px: 0.75,
                py: 0.25,
                fontSize: '0.65rem',
                cursor: 'pointer',
                '&:hover': { bgcolor: activeType === t ? 'primary.dark' : 'action.hover' },
              }}
            >
              {TYPE_LABELS[t]}
            </Box>
          ))}
        </Box>
        {insight && (
          <Tooltip title={copied ? 'Copied!' : 'Copy'}>
            <IconButton size="small" onClick={handleCopy} sx={{ p: 0.25 }}>
              <ContentCopyIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Regenerate">
          <IconButton
            size="small"
            onClick={() => onRegenerate(activeType)}
            disabled={loading}
            sx={{ p: 0.25 }}
          >
            <RefreshIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Close">
          <IconButton size="small" onClick={onClose} sx={{ p: 0.25 }}>
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Content */}
      <Box sx={{ overflowY: 'auto', flex: 1 }}>
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
            <CircularProgress size={18} />
          </Box>
        )}
        {!loading && error && (
          <Typography variant="caption" color="error">
            {error}
          </Typography>
        )}
        {!loading && !error && insight && (
          <Typography variant="caption" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
            {insight.text}
          </Typography>
        )}
      </Box>
    </Paper>
  );
}
