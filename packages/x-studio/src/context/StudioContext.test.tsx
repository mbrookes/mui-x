import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { StudioProvider } from './StudioContext';
import { useStudioUIConfig } from '../internals/StudioUIConfigContext';
import { StudioController } from '../store/StudioController';

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
