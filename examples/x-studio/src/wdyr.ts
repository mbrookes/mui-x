/// <reference types="@welldone-software/why-did-you-render" />
import * as React from 'react';

// why-did-you-render patches React internals and makes every render measurably
// slower — do NOT activate it unconditionally in dev. Enable on-demand by
// setting localStorage.wdyr = '1' and hard-refreshing, e.g.:
//   localStorage.setItem('wdyr', '1'); location.reload();
// To disable: localStorage.removeItem('wdyr'); location.reload();
if (import.meta.env.DEV && localStorage.getItem('wdyr') === '1') {
  const { default: whyDidYouRender } = await import('@welldone-software/why-did-you-render');
  whyDidYouRender(React, {
    // Don't track all pure components — the DataGrid has hundreds of internal
    // memo'd cells that flood the console. Enable per-component as needed:
    //   MyComponent.whyDidYouRender = true;
    trackAllPureComponents: false,
    trackHooks: true,
    logOwnerReasons: true,
    collapseGroups: true,
  });
}
