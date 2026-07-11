import { createGapCollector, gapOrigin } from './index';

describe('gap origin', () => {
  it('classifies an x-charts render limitation as `x-charts`', () => {
    expect(gapOrigin('mark:gradient-fill')).to.equal('x-charts');
    expect(gapOrigin('scale:temporal-point-approximation')).to.equal('x-charts');
    expect(gapOrigin('resolve:independent-scale')).to.equal('x-charts');
  });

  it('classifies an unsupported Vega-Lite feature as `vega-lite`', () => {
    expect(gapOrigin('composition:repeat')).to.equal('vega-lite');
    expect(gapOrigin('data:url')).to.equal('vega-lite');
    expect(gapOrigin('mark:geoshape-lookup')).to.equal('vega-lite');
  });

  it('stamps the origin on every collected gap from its code', () => {
    const collector = createGapCollector();
    collector.add({ code: 'mark:gradient-fill', message: 'm', severity: 'ignored' });
    collector.add({ code: 'composition:repeat', message: 'm', severity: 'unsupported' });
    const [xCharts, vegaLite] = collector.list();
    expect(xCharts.origin).to.equal('x-charts');
    expect(vegaLite.origin).to.equal('vega-lite');
  });

  it('lets a call site override the classification explicitly', () => {
    const collector = createGapCollector();
    // A normally-vega-lite code forced to x-charts by the call site.
    collector.add({
      code: 'encoding:tooltip',
      message: 'm',
      severity: 'ignored',
      origin: 'x-charts',
    });
    expect(collector.list()[0].origin).to.equal('x-charts');
  });
});
