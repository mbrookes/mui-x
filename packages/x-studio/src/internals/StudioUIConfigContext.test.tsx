import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioMapGeographyDefinition } from '@mui/x-studio-core/engine';
import {
  StudioUIConfigContext,
  useStudioGeographies,
  DEFAULT_STUDIO_LOCALE_TEXT,
} from './StudioUIConfigContext';

type Geographies = Record<string, StudioMapGeographyDefinition>;

const { render } = createRenderer();

function makeGeography(label: string): StudioMapGeographyDefinition {
  return {
    label,
    loader: async () => ({ type: 'FeatureCollection' as const, features: [] }),
    normalizer: (value) => String(value),
  };
}

/**
 * `renderHook`'s `wrapper` does not receive the hook's props, and the value under test comes
 * from context — so drive it with a plain harness + `setProps` instead.
 */
function renderGeographies(initialGeographies: Geographies | undefined) {
  let latest: Geographies = {};

  function Probe() {
    latest = useStudioGeographies();
    return null;
  }

  function Harness({ geographies }: { geographies: Geographies | undefined }) {
    // Memoized on `geographies` alone: the point of this suite is that
    // `useStudioGeographies` re-derives when the geographies OBJECT changes, so the
    // provider value must change exactly when that does — never on an unrelated render.
    const contextValue = React.useMemo(
      () => ({
        tableSourceMode: 'explicit' as const,
        featureFlags: {},
        localeText: DEFAULT_STUDIO_LOCALE_TEXT,
        geographies,
      }),
      [geographies],
    );
    return (
      <StudioUIConfigContext.Provider value={contextValue}>
        <Probe />
      </StudioUIConfigContext.Provider>
    );
  }

  const { setProps } = render(<Harness geographies={initialGeographies} />);
  return {
    get current() {
      return latest;
    },
    rerender: (geographies: Geographies | undefined) => setProps({ geographies }),
  };
}

describe('useStudioGeographies', () => {
  it('merges consumer geographies over the built-ins', () => {
    const view = renderGeographies({ 'uk-counties': makeGeography('United Kingdom') });

    expect(view.current['uk-counties'].label).toBe('United Kingdom');
    // Built-ins survive the merge.
    expect(view.current.world).not.toBe(undefined);
  });

  // ── M3 regression ──────────────────────────────────────────────────────────
  //
  // The memo used to depend solely on `JSON.stringify(Object.keys(geographies ?? {}))`, a
  // proxy that only tracked the SET of registered keys. A host that re-rendered with a
  // corrected `normalizer`, an updated `loader`, or a renamed `label` under the SAME key
  // therefore kept the stale definition for the lifetime of the mount. Exactly the bug
  // already diagnosed and fixed for the sibling `useWidgetDefMap`.
  it('picks up a changed definition under an unchanged key', () => {
    const view = renderGeographies({ 'uk-counties': makeGeography('Old label') });
    expect(view.current['uk-counties'].label).toBe('Old label');

    const updated = makeGeography('Corrected label');
    view.rerender({ 'uk-counties': updated });

    expect(view.current['uk-counties'].label).toBe('Corrected label');
    expect(view.current['uk-counties'].normalizer).toBe(updated.normalizer);
  });

  it('picks up an overridden built-in whose key was already present', () => {
    const view = renderGeographies({ world: makeGeography('World v1') });
    expect(view.current.world.label).toBe('World v1');

    view.rerender({ world: makeGeography('World v2') });

    expect(view.current.world.label).toBe('World v2');
  });
});
