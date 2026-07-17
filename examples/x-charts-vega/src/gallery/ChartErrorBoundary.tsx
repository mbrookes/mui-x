import * as React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

interface ChartErrorBoundaryState {
  error: Error | null;
}

/**
 * A gallery renders ~190 independent example specs on one page — some
 * exercise wrapper code paths no curated demo ever hit, so an occasional
 * crash is expected as coverage grows. Without a boundary per card, React
 * unmounts the whole tree up to the nearest one (here, none), blanking every
 * other example along with the broken one. Catching per-card turns "the
 * entire gallery is blank" into "this one card shows its error", so the rest
 * keep rendering.
 */
export class ChartErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ChartErrorBoundaryState
> {
  state: ChartErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ChartErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Box
          sx={{
            border: '1px solid',
            borderColor: 'error.main',
            borderRadius: 1,
            p: 1.5,
            bgcolor: 'error.50',
            maxWidth: 440,
          }}
        >
          <Typography variant="body2" color="error.main" sx={{ fontWeight: 600 }}>
            Failed to render
          </Typography>
          <Typography
            variant="caption"
            component="pre"
            sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', m: 0 }}
          >
            {this.state.error.message}
          </Typography>
        </Box>
      );
    }
    return this.props.children;
  }
}
