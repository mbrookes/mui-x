import * as React from 'react';
import { Box, Divider } from '@mui/material';
import type { StudioCustomWidgetDef } from '@mui/x-studio';

function DividerWidget() {
  // The widget is full-bleed (its card has no padding), so inset the rule horizontally by
  // the default card padding (2) to line it up with the inset content of the other widgets.
  // The inset is applied via the wrapper's padding rather than the Divider's margin, because
  // the card body Stack resets its children's margins.
  return (
    <Box sx={{ px: 2, py: 1 }}>
      <Divider />
    </Box>
  );
}

export const dividerWidgetDef: StudioCustomWidgetDef = {
  kind: 'survey-divider',
  label: 'Divider',
  fullBleed: true,
  component: DividerWidget,
};
