import * as React from 'react';
import { ScatterMarker } from '@mui/x-charts/ScatterChart';
import type { ScatterMarkerProps } from '@mui/x-charts/ScatterChart';

/**
 * A scatter marker slot that renders hollow (stroke-only) circles for the
 * series ids in `hollowIds`, and delegates to the default solid `ScatterMarker`
 * for every other series. This reproduces Vega-Lite's `point` mark, which is
 * unfilled by default (and any mark with `filled: false`): overlapping points
 * stay legible as outlined circles instead of merging into a solid blob.
 *
 * `createHollowScatterMarker` returns a stable component per id-set so the
 * shell can pass it straight into `<ScatterPlot slots={{ marker }} />`.
 */
export function createHollowScatterMarker(
  hollowIds: ReadonlySet<string>,
): React.ComponentType<ScatterMarkerProps> {
  return function HollowScatterMarker(props: ScatterMarkerProps) {
    if (!hollowIds.has(String(props.seriesId))) {
      return <ScatterMarker {...props} />;
    }
    const { seriesId, isFaded, isHighlighted, x, y, color, size, dataIndex, ...other } = props;
    return (
      <circle
        cx={0}
        cy={0}
        r={(isHighlighted ? 1.2 : 1) * size}
        transform={`translate(${x}, ${y})`}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        opacity={isFaded ? 0.3 : 1}
        cursor={other.onClick ? 'pointer' : 'unset'}
        {...other}
      />
    );
  };
}
