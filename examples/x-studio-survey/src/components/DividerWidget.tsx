import * as React from 'react';
import { Divider } from '@mui/material';
import type { StudioCustomWidgetDef } from '@mui/x-studio';

function DividerWidget() {
  return <Divider sx={{ my: 1 }} />;
}

export const dividerWidgetDef: StudioCustomWidgetDef = {
  kind: 'survey-divider',
  label: 'Divider',
  fullBleed: true,
  component: DividerWidget,
};
