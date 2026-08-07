import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStudioLocale, setActiveStudioLocale, formatNumber } from '@mui/x-studio-core/engine';
import { StudioController } from '@mui/x-studio-core/store';
import { useStudioUIConfig, useStudioLocale } from '../internals/StudioUIConfigContext';
import { StudioProvider, useStudioController } from './StudioContext';

const { render } = createRenderer();

describe('StudioProvider', () => {
  it('keeps the uiConfig context value referentially stable across re-renders when featureFlags is omitted', () => {
    const controller = new StudioController();
    const configs: unknown[] = [];

    function Consumer() {
      const uiConfig = useStudioUIConfig();
      configs.push(uiConfig);
      return null;
    }

    function Wrapper({ tick: _tick }: { tick: number }) {
      // `tick` is unused by the tree below — it only exists to force `Wrapper`
      // (and therefore `StudioProvider`) to re-render.
      return (
        <StudioProvider controller={controller}>
          <Consumer />
        </StudioProvider>
      );
    }

    // `strict: false` — StrictMode double-invokes render, which would double the
    // `configs` entries per commit and defeat the render-counting assertions below.
    const { setProps } = render(<Wrapper tick={0} />, { strict: false });
    expect(configs).toHaveLength(1);

    // Re-render the parent without changing any StudioProvider props. Before the
    // fix, the default `featureFlags = {}` created a new object on every render,
    // which busted the `uiConfig` memo and produced a new context value here.
    setProps({ tick: 1 });

    expect(configs).toHaveLength(2);
    expect(configs[1]).toBe(configs[0]);
  });
});

// `localeText` chose the STRINGS but nothing chose the FORMATTERS: every `Intl` call in the
// package passed `undefined`, i.e. the browser locale. `<Studio localeText={frLocaleText} />`
// in an `en-US` browser therefore rendered French labels next to `1,234.5`. The `locale` prop
// closes that, and `StudioProvider` publishes it to the non-React formatting helpers.
describe('StudioProvider — locale prop', () => {
  afterEach(() => {
    setActiveStudioLocale(undefined);
  });

  it('exposes the locale on the UI config for `useStudioLocale()`', () => {
    const controller = new StudioController();
    let seen: string | undefined = 'unset';

    function Consumer() {
      seen = useStudioLocale();
      return null;
    }

    render(
      <StudioProvider controller={controller} locale="fr-FR">
        <Consumer />
      </StudioProvider>,
      { strict: false },
    );

    expect(seen).toBe('fr-FR');
  });

  it('leaves the locale undefined when the prop is omitted, preserving browser-locale defaults', () => {
    const controller = new StudioController();
    let seen: string | undefined = 'unset';

    function Consumer() {
      seen = useStudioLocale();
      return null;
    }

    render(
      <StudioProvider controller={controller}>
        <Consumer />
      </StudioProvider>,
      { strict: false },
    );

    expect(seen).toBeUndefined();
    expect(getStudioLocale()).toBeUndefined();
  });

  it('publishes the locale to the non-React Intl helpers before children render', () => {
    const controller = new StudioController();
    let formattedDuringRender = '';

    function Consumer() {
      // Deliberately read during render, not in an effect: widgets format their values in
      // the render pass, so a `useEffect`-based publish would leave the first paint
      // formatted against the browser locale.
      formattedDuringRender = formatNumber(1234567, 'integer');
      return null;
    }

    render(
      <StudioProvider controller={controller} locale="de-DE">
        <Consumer />
      </StudioProvider>,
      { strict: false },
    );

    expect(formattedDuringRender).toBe('1.234.567');
  });
});

// `useStudioController` is a documented public export, so its "used outside a provider"
// throw is the package's highest-traffic error. It said only what happened — no `MUI X`
// prefix, no consequence, no doc link — against the AGENTS.md error-message contract that
// `sseUtils.ts:140` and `createSimpleAdapter.ts` already follow.
describe('useStudioController outside a provider', () => {
  it('throws a prefixed, actionable error', () => {
    function Consumer() {
      useStudioController();
      return null;
    }

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Consumer />, { strict: false })).to.throw(
        /^MUI X Studio: .*https:\/\/mui\.com\/x\//s,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
