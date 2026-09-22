// Node-safe entry point for x-studio-shared.
//
// `index.ts` is the browser barrel: it re-exports `FeatureFlagSettings` (React +
// @mui/material) and the office-supplies demo state, so importing it from a Node
// process (the dev server) drags the whole UI dependency graph in and fails to
// resolve. This entry exposes only the data generators and dashboard config the
// server actually needs — no React, no @mui/x-studio.
export * from './src/salesData/index.js';
export * from './src/crmData/index.js';
export { INITIAL_STATE } from './src/config/salesDashboard.js';
