import type { TooltipItemPositionGetter } from '@mui/x-charts/internals';

// For choropleth charts, the tooltip follows the pointer position (no fixed anchor per feature).
// Returning null causes the tooltip container to use the pointer anchor automatically.
const tooltipItemPositionGetter: TooltipItemPositionGetter<'choropleth'> = () => null;

export default tooltipItemPositionGetter;
