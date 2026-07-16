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
    const specObj = (spec ?? {}) as { width?: unknown; height?: unknown };
    const embedOpts: { actions: false; renderer: 'svg'; width?: number; height?: number } = {
      actions: false,
      renderer: 'svg',
    };
    if (typeof specObj.width !== 'number') {
      embedOpts.width = width;
    }
    if (typeof specObj.height !== 'number') {
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
