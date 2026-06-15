// wdyr must be the very first import — before React
import './wdyr';

import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import App from './App';
import { reportWebVitals } from './reportWebVitals';

// react-scan: opt-in only — activate via either:
//   • pnpm dev:scan  (sets VITE_REACT_SCAN=true for the whole session)
//   • localStorage.setItem('reactScan', '1'); location.reload()  (per-tab toggle)
if (
  import.meta.env.DEV &&
  (import.meta.env.VITE_REACT_SCAN === 'true' || localStorage.getItem('reactScan') === '1')
) {
  const { scan } = await import(/* @vite-ignore */ 'react-scan');
  scan({ enabled: true, log: false, showToolbar: true });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

reportWebVitals();
