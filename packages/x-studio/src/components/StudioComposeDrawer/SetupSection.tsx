'use client';
import * as React from 'react';
import { Divider, Typography } from '@mui/material';

interface SetupSectionProps {
  /** Section heading shown below the divider. */
  title: string;
  /** Optional helper text shown below the title. */
  description?: string;
  /** Additional spacing between the divider and the title (default: 1.5). */
  dividerMb?: number;
  children?: React.ReactNode;
}

/**
 * Shared layout block for widget setup-panel sections.
 * Renders a `<Divider>`, a `caption` heading, an optional description line,
 * then the section content — replacing the repeated inline pattern across all
 * setup panels (Chart, KPI, Grid, Map, Pivot).
 */
export function SetupSection({ title, description, dividerMb = 1.5, children }: SetupSectionProps) {
  return (
    <div>
      <Divider sx={{ mb: dividerMb }} />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mb: description ? 0.75 : 1 }}
      >
        {title}
      </Typography>
      {description && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          {description}
        </Typography>
      )}
      {children}
    </div>
  );
}
