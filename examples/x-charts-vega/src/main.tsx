import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { LicenseInfo } from '@mui/x-license';
import App from './App';

// The gallery renders `@mui/x-charts-pro`/`-premium` components (Heatmap, Map,
// range bars), which watermark themselves without a commercial license. Register
// the repository's shared test key (accepted because `vite.config.ts` defines
// `__ALLOW_TEST_LICENSES__`) so the demo charts render cleanly.
LicenseInfo.setLicenseKey(
  '715a2f48d6140e8e6f2484e6c4b981aeTz0xMjMsRT00MTAyMzU0ODAwMDAwLFM9cHJlbWl1bSxMTT1hbm51YWwsUFY9UTMtMjAyNCxUPXRydWUsS1Y9Mg==',
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
