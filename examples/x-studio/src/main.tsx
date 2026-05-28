// wdyr must be the very first import — before React
import './wdyr';

import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import App from './App';
import { reportWebVitals } from './reportWebVitals';


ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

reportWebVitals();
