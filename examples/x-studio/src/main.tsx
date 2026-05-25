// wdyr must be the very first import — before React
import './wdyr';

import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import App from './App';
import { reportWebVitals } from './reportWebVitals';

// react-scan: opt-in only — activate via either:
//   • pnpm dev:scan  (sets VITE_REACT_SCAN=true for the whole session)
//   • localStorage.setItem('reactScan', '1'); location.reload()  (per-tab toggle)
// The module is 685 KB; it is never pre-bundled by Vite (see optimizeDeps.exclude
// in vite.config.ts) and never downloaded unless one of the above is set.
if (import.meta.env.DEV && (import.meta.env.VITE_REACT_SCAN === 'true' || localStorage.getItem('reactScan') === '1')) {
  const { scan } = await import('react-scan');
  scan({ enabled: true, log: false, showToolbar: true });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

reportWebVitals();
