/**
 * Tests for `useWidgetDefMap` (finding 3.3).
 *
 * A prior version keyed the internal `useMemo` on
 * `JSON.stringify(customWidgets?.map(d => d.kind))` — a proxy that only tracked
 * the SET of registered kind strings. That went stale whenever a consumer
 * updated a custom widget def's actual content (swapped `component`, changed
 * `capabilities`, relabeled it, …) without adding or removing a kind: the kind
 * list stayed identical, so the memo never recomputed and callers kept reading
 * the OLD def. These tests pin the fixed behaviour: the map reflects the
 * latest `customWidgets` content, and is referentially stable across a
 * no-op rerender (same `customWidgets` reference).
 */
import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook } from '@mui/internal-test-utils';
import type { StudioCustomWidgetDef } from '../models';
import { StudioUIConfigContext, DEFAULT_STUDIO_LOCALE_TEXT } from './StudioUIConfigContext';
import { useWidgetDefMap, BUILTIN_WIDGET_DEFS } from './builtinWidgetDefs';

// Mutable slot the `Wrapper` component below reads from on every render. Tests
// mutate this and call `rerender()` — RTL re-renders the whole `<Wrapper>`
// subtree on `rerender()`, so `Wrapper` re-executes and picks up the new value
// even though `Wrapper` itself receives no changed props (`renderHook`'s
// `rerender` only threads new props to the hook callback, not to `wrapper`).
let currentCustomWidgets: StudioCustomWidgetDef[] | undefined;

function Wrapper({ children }: { children?: React.ReactNode }) {
  return React.createElement(
    StudioUIConfigContext.Provider,
    {
      value: {
        tableSourceMode: 'explicit',
        featureFlags: {},
        localeText: DEFAULT_STUDIO_LOCALE_TEXT,
        customWidgets: currentCustomWidgets,
      },
    },
    children,
  );
}

function customDef(overrides: Partial<StudioCustomWidgetDef> = {}): StudioCustomWidgetDef {
  return {
    kind: 'acme-widget',
    label: 'Acme Widget',
    component: () => null,
    ...overrides,
  };
}

describe('useWidgetDefMap', () => {
  it('includes every built-in kind plus a registered custom widget def', () => {
    currentCustomWidgets = [customDef({ label: 'Acme Widget' })];
    const { result } = renderHook(() => useWidgetDefMap(), { wrapper: Wrapper });

    for (const kind of Object.keys(BUILTIN_WIDGET_DEFS)) {
      expect(result.current.has(kind)).toBe(true);
    }
    expect(result.current.get('acme-widget')?.label).toBe('Acme Widget');
  });

  it("recomputes when a custom widget def's content changes even though its kind stays the same", () => {
    currentCustomWidgets = [customDef({ label: 'Original Label' })];
    const { result, rerender } = renderHook(() => useWidgetDefMap(), { wrapper: Wrapper });

    expect(result.current.get('acme-widget')?.label).toBe('Original Label');
    const firstMap = result.current;

    // Same kind ('acme-widget'), different content — the old
    // `JSON.stringify(kinds)` memo key would not have detected this change.
    currentCustomWidgets = [customDef({ label: 'Updated Label' })];
    rerender();

    expect(result.current.get('acme-widget')?.label).toBe('Updated Label');
    expect(result.current).not.toBe(firstMap);
  });

  it('is referentially stable across a rerender when customWidgets is unchanged', () => {
    const stableCustomWidgets = [customDef()];
    currentCustomWidgets = stableCustomWidgets;
    const { result, rerender } = renderHook(() => useWidgetDefMap(), { wrapper: Wrapper });

    const firstMap = result.current;
    rerender();

    expect(result.current).toBe(firstMap);
  });
});
