/// <reference types="@welldone-software/why-did-you-render" />
import * as React from 'react';

// why-did-you-render patches React internals and makes every render measurably
// slower — do NOT activate it unconditionally in dev. Enable via either:
//   • pnpm dev:wdyr  (sets VITE_WDYR=true for the whole session)
//   • localStorage.setItem('wdyr', '1'); location.reload()  (per-tab toggle)
// To disable the localStorage flag: localStorage.removeItem('wdyr'); location.reload()
if (
  import.meta.env.DEV &&
  (import.meta.env.VITE_WDYR === 'true' || localStorage.getItem('wdyr') === '1')
) {
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
