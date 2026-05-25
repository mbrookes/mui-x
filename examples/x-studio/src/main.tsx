// wdyr must be the very first import — before React
import './wdyr';

import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import App from './App';
import { reportWebVitals } from './reportWebVitals';

// react-scan: opt-in only — set localStorage.reactScan = '1' to activate.
// The bundle is 685 KB and slows every render; never load it passively.
if (import.meta.env.DEV && localStorage.getItem('reactScan') === '1') {
  const { scan } = await import('react-scan');
  scan({ enabled: true, log: false, showToolbar: true });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

reportWebVitals();
