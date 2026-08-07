import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import { StudioWidgetErrorBoundary } from './StudioWidgetErrorBoundary';

const { render } = createRenderer();

const RETRY_LABEL = DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip;

/** Throws on every render while `explode` is true — the test flips the prop, never a counter,
 *  so StrictMode's double render can't accidentally "use up" a one-shot failure. */
function Boom({ explode }: { explode: boolean }) {
  if (explode) {
    throw new Error('widget exploded');
  }
  return <div data-testid="widget-content">rendered</div>;
}

describe('<StudioWidgetErrorBoundary />', () => {
  let errorSpy: { mockRestore: () => void };

  beforeEach(() => {
    // React logs every boundary-caught error to console.error.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  // Regression (H5a): `getDerivedStateFromError` latches `hasError` forever. The boundary
  // used to offer recovery ONLY through `resetKey={JSON.stringify(widget.config)}`, so a
  // transient failure whose cause lived outside `config` — one bad adapter batch, a
  // formatter throwing on a since-replaced row — stuck the widget on the error overlay for
  // the rest of the session. Under `StudioDashboard` (`featureFlags.compose: false`) there
  // is no config-editing UI at all, so that was unrecoverable without a page reload.
  it('recovers on Retry after a widget that threw once starts rendering again', () => {
    const stableKey = { config: 'unchanged' };
    const { setProps } = render(
      <StudioWidgetErrorBoundary resetKeys={[stableKey]}>
        <Boom explode />
      </StudioWidgetErrorBoundary>,
    );

    expect(screen.getByText('widget exploded')).not.toBe(null);

    // The underlying failure is gone, but nothing in `resetKeys` moved — the boundary is
    // still latched, which is exactly the state the Retry button exists for.
    setProps({ children: <Boom explode={false} />, resetKeys: [stableKey] });
    expect(screen.queryByTestId('widget-content')).toBe(null);

    fireEvent.click(screen.getByRole('button', { name: RETRY_LABEL }));

    expect(screen.getByTestId('widget-content')).not.toBe(null);
    expect(screen.queryByText('widget exploded')).toBe(null);
  });

  it('keeps showing the overlay when Retry re-renders a child that still throws', () => {
    const { setProps } = render(
      <StudioWidgetErrorBoundary resetKeys={[1]}>
        <Boom explode />
      </StudioWidgetErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: RETRY_LABEL }));

    expect(screen.getByText('widget exploded')).not.toBe(null);

    // …and a later genuine recovery still works.
    setProps({ children: <Boom explode={false} />, resetKeys: [2] });
    expect(screen.getByTestId('widget-content')).not.toBe(null);
  });

  it('clears a latched error when a reset key identity changes', () => {
    const configA = { a: 1 };
    const configB = { a: 1 };
    const { setProps } = render(
      <StudioWidgetErrorBoundary resetKeys={[configA, 'source-1']}>
        <Boom explode />
      </StudioWidgetErrorBoundary>,
    );

    expect(screen.getByText('widget exploded')).not.toBe(null);

    // Deep-equal but a different reference: `Object.is` treats this as a change, which is
    // the point — the store hands out a new object for every doc/data mutation.
    setProps({ children: <Boom explode={false} />, resetKeys: [configB, 'source-1'] });

    expect(screen.getByTestId('widget-content')).not.toBe(null);
  });

  it('clears a latched error when only the non-config keys change (sourceId / data generation)', () => {
    const config = { a: 1 };
    const { setProps } = render(
      <StudioWidgetErrorBoundary resetKeys={[config, 'source-1']}>
        <Boom explode />
      </StudioWidgetErrorBoundary>,
    );

    expect(screen.getByText('widget exploded')).not.toBe(null);

    // `sourceId` lives OUTSIDE `widget.config`, so the old stringified-config key never
    // noticed a source swap and the widget stayed broken after being repointed at good data.
    setProps({ children: <Boom explode={false} />, resetKeys: [config, 'source-2'] });

    expect(screen.getByTestId('widget-content')).not.toBe(null);
  });

  it('does not clear a latched error while every reset key is identical', () => {
    const config = { a: 1 };
    const { setProps } = render(
      <StudioWidgetErrorBoundary resetKeys={[config]}>
        <Boom explode />
      </StudioWidgetErrorBoundary>,
    );

    // A fresh array literal with identical members must NOT count as a change — callers
    // build `resetKeys` inline on every render, so array identity is meaningless here.
    setProps({ children: <Boom explode={false} />, resetKeys: [config] });

    expect(screen.queryByTestId('widget-content')).toBe(null);
    expect(screen.getByText('widget exploded')).not.toBe(null);
  });

  // Regression (H5b): the reset key used to be `JSON.stringify(widget.config)`, and a custom
  // widget kind's `defaultConfig` is arbitrary consumer data copied verbatim into `config`.
  // A cyclic or `BigInt`-bearing config made `JSON.stringify` throw while computing the
  // boundary's OWN prop — in the parent's render phase, ABOVE the boundary — so it unmounted
  // the whole tree from the very prop meant to contain widget failures. Identity comparison
  // never serializes, so no value can crash the boundary.
  it('never serializes its reset keys, so cyclic / BigInt values are safe', () => {
    const cyclicA: Record<string, unknown> = { kind: 'custom' };
    cyclicA.self = cyclicA;
    const cyclicB: Record<string, unknown> = { kind: 'custom', big: BigInt(1) };
    cyclicB.self = cyclicB;

    const { setProps } = render(
      <StudioWidgetErrorBoundary resetKeys={[cyclicA]}>
        <Boom explode />
      </StudioWidgetErrorBoundary>,
    );

    expect(screen.getByText('widget exploded')).not.toBe(null);

    // Comparing the two cyclic configs must not throw either.
    setProps({ children: <Boom explode={false} />, resetKeys: [cyclicB] });

    expect(screen.getByTestId('widget-content')).not.toBe(null);
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <StudioWidgetErrorBoundary resetKeys={[1]}>
        <Boom explode={false} />
      </StudioWidgetErrorBoundary>,
    );

    expect(screen.getByTestId('widget-content')).not.toBe(null);
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).toBe(null);
  });
});
