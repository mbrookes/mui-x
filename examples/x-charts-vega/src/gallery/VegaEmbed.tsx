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
    // Let Vega size the view to fit the panel; a `width`/`height` in the spec
    // still wins (some gallery specs pin their own size).
    embed(el, spec as VisualizationSpec, {
      actions: false,
      renderer: 'svg',
      width,
      height,
    })
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
