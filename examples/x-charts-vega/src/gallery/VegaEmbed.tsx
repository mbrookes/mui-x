import * as React from 'react';
import embed from 'vega-embed';
import type { VisualizationSpec } from 'vega-embed';

/**
 * Renders a Vega-Lite spec with the reference `vega`/`vega-lite` runtime (via
 * `vega-embed`), so the gallery can show the canonical output side by side with
 * the `@mui/x-charts-vega` translation of the same spec. The spec is passed
 * with data already inlined (see `resolveData`), matching what the wrapper
 * receives, so any difference is a translation difference, not a data one.
 */
/**
 * Whether ANY view in the spec tree pins its own `width`/`height`.
 *
 * A composite pins its size on the child views, not at the top level —
 * `interactive_seattle_weather` declares `width: 600` on each `vconcat` entry
 * and nothing at the root. Checking only the root therefore passed the panel
 * size to `vega-embed`, whose `width` option overrides what the spec asked for,
 * and the reference rendered at 440 where both the spec and the wrapper say
 * 600. That is the embed resizing the reference, which is exactly what this
 * check exists to prevent — it just was not looking deep enough.
 */
function declaresSize(node: unknown, key: 'width' | 'height'): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => declaresSize(child, key));
  }
  if (typeof node !== 'object' || node === null) {
    return false;
  }
  const view = node as Record<string, unknown>;
  if (typeof view[key] === 'number') {
    return true;
  }
  // Only the view-composition branches carry nested views; recursing over every
  // key would find a `width` inside unrelated config or encoding objects.
  return (['layer', 'vconcat', 'hconcat', 'concat', 'spec', 'facet'] as const).some((branch) =>
    declaresSize(view[branch], key),
  );
}

export default function VegaEmbed({
  spec,
  width,
  height,
}: {
  spec: unknown;
  width: number;
  height: number;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) {
      return undefined;
    }
    let view: { finalize: () => void } | undefined;
    let cancelled = false;
    setError(null);
    // Only impose the panel size on views that declare no size of their own, so
    // a size-less chart renders at the same default as the wrapper (a fair
    // comparison). A spec that pins its own `width`/`height` (e.g. the density
    // plot's `height: 100`) keeps it — otherwise the embed override would resize
    // the reference and make it disagree with the wrapper, which honors the spec.
    const embedOpts: { actions: false; renderer: 'svg'; width?: number; height?: number } = {
      actions: false,
      renderer: 'svg',
    };
    if (!declaresSize(spec, 'width')) {
      embedOpts.width = width;
    }
    if (!declaresSize(spec, 'height')) {
      embedOpts.height = height;
    }
    embed(el, spec as VisualizationSpec, embedOpts)
      .then((result) => {
        if (cancelled) {
          result.view.finalize();
          return;
        }
        view = result.view;
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err?.message ?? err));
        }
      });
    return () => {
      cancelled = true;
      view?.finalize();
      if (el) {
        el.innerHTML = '';
      }
    };
  }, [spec, width, height]);

  return (
    <React.Fragment>
      <div ref={ref} />
      {error && (
        <pre style={{ color: '#c00', fontSize: 12, whiteSpace: 'pre-wrap', margin: 0 }}>
          vega-embed error: {error}
        </pre>
      )}
    </React.Fragment>
  );
}
