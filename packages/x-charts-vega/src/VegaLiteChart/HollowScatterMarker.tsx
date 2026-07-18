import * as React from 'react';
import { ScatterMarker } from '@mui/x-charts/ScatterChart';
import type { ScatterMarkerProps } from '@mui/x-charts/ScatterChart';

/**
 * A scatter marker slot that renders hollow (stroke-only) circles for the
 * series ids in `hollowIds`, a solid fill plus a distinct outline color for
 * the series ids in `strokeOverrides`, and delegates to the default solid
 * `ScatterMarker` for everyone else.
 *
 * The hollow style reproduces Vega-Lite's `point` mark, which is unfilled by
 * default (and any mark with `filled: false`): overlapping points stay
 * legible as outlined circles instead of merging into a solid blob. The
 * stroke-override style reproduces a `point`/`circle` mark with an explicit
 * `mark.stroke` alongside its fill (a filled circle with its own border,
 * distinct from the fill color).
 *
 * `createScatterMarkerOverrides` returns a stable component per config so the
 * shell can pass it straight into `<ScatterPlot slots={{ marker }} />`.
 */
export function createScatterMarkerOverrides(config: {
  hollowIds?: ReadonlySet<string>;
  strokeOverrides?: ReadonlyMap<string, { color: string; width?: number }>;
}): React.ComponentType<ScatterMarkerProps> {
  const { hollowIds, strokeOverrides } = config;
  return function StyledScatterMarker(props: ScatterMarkerProps) {
    const id = String(props.seriesId);
    const { seriesId, isFaded, isHighlighted, x, y, color, size, dataIndex, ...other } = props;
    const radius = (isHighlighted ? 1.2 : 1) * size;
    const opacity = isFaded ? 0.3 : 1;
    const cursor = other.onClick ? 'pointer' : 'unset';

    if (hollowIds?.has(id)) {
      return (
        <circle
          cx={0}
          cy={0}
          r={radius}
          transform={`translate(${x}, ${y})`}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          opacity={opacity}
          cursor={cursor}
          {...other}
        />
      );
    }

    const strokeOverride = strokeOverrides?.get(id);
    if (strokeOverride) {
      return (
        <circle
          cx={0}
          cy={0}
          r={radius}
          transform={`translate(${x}, ${y})`}
          fill={color}
          stroke={strokeOverride.color}
          strokeWidth={strokeOverride.width ?? 1.5}
          opacity={opacity}
          cursor={cursor}
          {...other}
        />
      );
    }

    return <ScatterMarker {...props} />;
  };
}
