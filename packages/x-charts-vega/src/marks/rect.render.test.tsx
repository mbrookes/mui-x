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

  // Regression: the premium provider's default seriesConfig registers no
  // heatmap processor; the shell merges `heatmapSeriesConfig` (imported via
  // `@mui/x-charts-pro/Heatmap/seriesConfig` — the `./*` exports pattern
  // matches nested paths) into the config it passes down.
  it('renders heatmap cells through <VegaLiteChart />', () => {
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={gridSpec} onGaps={() => {}} />,
    );
    expect(container.querySelectorAll(`.${heatmapClasses.cell}`).length).to.equal(4);
  });
});
