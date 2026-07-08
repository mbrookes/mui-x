import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { Heatmap, heatmapClasses } from '@mui/x-charts-pro/Heatmap';
import type { XAxis, YAxis } from '@mui/x-charts/models';
import { VegaLiteChart } from '../VegaLiteChart';
import { compileSpec } from '../compile';
import type { TranslationGap } from '../gaps';
import type { VegaLiteSpec } from '../types';

describe('<VegaLiteChart /> rect/heatmap mark', () => {
  const { render } = createRenderer();

  const gridSpec: VegaLiteSpec = {
    data: {
      values: [
        { day: 'Mon', hour: 9, temp: 12 },
        { day: 'Mon', hour: 10, temp: 18 },
        { day: 'Tue', hour: 9, temp: 20 },
        { day: 'Tue', hour: 10, temp: 30 },
      ],
    },
    mark: 'rect',
    encoding: {
      x: { field: 'day', type: 'ordinal' },
      y: { field: 'hour', type: 'ordinal' },
      color: { field: 'temp', type: 'quantitative' },
    },
  };

  it('compiles a two-discrete-axis rect spec into a heatmap series/zAxis that <Heatmap> renders as one cell per grid position', () => {
    const compiled = compileSpec(gridSpec);
    expect(compiled.plots).to.deep.equal(['heatmap']);
    expect(compiled.zAxis).to.have.length(1);

    // Feeds the compiled output straight into the real `<Heatmap>` renderer
    // from @mui/x-charts-pro (the same component <VegaLiteChart> mounts via
    // <HeatmapPlot />) to prove the series/xAxis/yAxis/zAxis shapes this
    // compiler produces are valid, renderable Heatmap input — see the
    // `it.skip` below for why asserting this through <VegaLiteChart /> itself
    // is currently blocked by an unrelated shell wiring gap.
    const { container } = render(
      <Heatmap
        width={500}
        height={350}
        series={compiled.series as never}
        xAxis={[compiled.xAxis!.config as XAxis<'band'>]}
        yAxis={[compiled.yAxis!.config as YAxis<'band'>]}
        zAxis={compiled.zAxis as never}
      />,
    );
    const cells = container.querySelectorAll(`.${heatmapClasses.cell}`);
    expect(cells.length).to.equal(4);
  });

  it('does not render heatmap cells and reports an unsupported gap when a positional axis is not discrete', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { day: 'Mon', temp: 12 },
          { day: 'Tue', temp: 20 },
        ],
      },
      mark: 'rect',
      encoding: {
        x: { field: 'day', type: 'ordinal' },
        y: { field: 'temp', type: 'quantitative' },
        color: { field: 'temp', type: 'quantitative' },
      },
    };
    let reported: TranslationGap[] = [];
    const { container } = render(
      <VegaLiteChart
        width={500}
        height={350}
        spec={spec}
        onGaps={(gaps) => {
          reported = gaps;
        }}
      />,
    );
    expect(container.querySelectorAll(`.${heatmapClasses.cell}`).length).to.equal(0);
    expect(reported.map((gap) => gap.code)).to.include('mark:rect-missing-discrete-axes');
  });

  // KNOWN SHELL GAP (outside this work unit's file ownership — see the final
  // report instead of fixing it here): <VegaLiteChart /> feeds heatmap series
  // into <ChartsDataProviderPremium> (packages/x-charts-vega/src/VegaLiteChart/VegaLiteChart.tsx),
  // but that provider's default seriesConfig
  // (packages/x-charts-premium/src/ChartsDataProviderPremium/ChartsDataProviderPremium.tsx
  // `defaultSeriesConfigPremium`, itself built on
  // packages/x-charts-pro/src/ChartsDataProviderPro/ChartsDataProviderPro.tsx
  // `defaultSeriesConfigPro`) never registers a `'heatmap'` processor — only
  // bar/scatter/line/pie/rangeBar/ohlc are wired in. The dedicated `<Heatmap>`
  // component works around this by passing its own local
  // `seriesConfig={{ heatmap: heatmapSeriesConfig }}` override (see
  // packages/x-charts-pro/src/Heatmap/useHeatmapProps.ts), but
  // `heatmapSeriesConfig` (packages/x-charts-pro/src/Heatmap/seriesConfig/index.ts)
  // isn't re-exported from any subpath reachable through x-charts-pro's
  // package.json `exports` map (only whole-folder `index.ts` barrels are
  // reachable — `@mui/x-charts-pro/Heatmap` does not export it), so
  // <VegaLiteChart /> has no way to obtain it either. As a result, mounting
  // <VegaLiteChart /> with any heatmap-producing spec currently throws
  // `TypeError: Cannot read properties of undefined (reading
  // 'getSeriesWithDefaultValues')` from
  // packages/x-charts/src/internals/plugins/corePlugins/useChartSeries/processSeries.ts
  // instead of rendering. Repro (throws instead of rendering 4 cells):
  //   render(<VegaLiteChart width={500} height={350} spec={gridSpec} onGaps={() => {}} />)
  it.todo(
    'BUG: renders heatmap cells through <VegaLiteChart /> (blocked by a shell seriesConfig gap, see comment above)',
  );
});
