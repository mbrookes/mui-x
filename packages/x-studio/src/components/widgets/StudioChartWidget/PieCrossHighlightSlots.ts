import { CrossHighlightPieArc } from './PieCrossHighlight';

// Stable slots object — defined at module scope so the reference never changes
// between renders and PieChart never unmounts/remounts its arc elements.
export const PIE_HIGHLIGHT_SLOTS = { pieArc: CrossHighlightPieArc } as const;
