import { compileSpec } from '../compile';
import type { VegaLiteSpec } from '../types';
import type { CompiledOverlay } from '../compile/context';

function textItems(overlays: CompiledOverlay[]) {
  const overlay = overlays.find((entry) => entry.kind === 'text');
  return overlay && overlay.kind === 'text' ? overlay.items : undefined;
}

describe('compileTextMark', () => {
  const rows = [
    { category: 'A', amount: 10 },
    { category: 'B', amount: 20 },
  ];

  const baseSpec: VegaLiteSpec = {
    data: { values: rows },
    mark: 'text',
    encoding: {
      x: { field: 'category', type: 'nominal' },
      y: { field: 'amount', type: 'quantitative' },
      text: { field: 'amount' },
    },
  };

  it('produces a text overlay with one item per row, stringifying the field value', () => {
    const compiled = compileSpec(baseSpec);
    expect(compiled.plots).to.deep.equal([]);
    const items = textItems(compiled.overlays);
    // Every item carries the centered default style (Vega-Lite text marks
    // default to align 'center' / baseline 'middle').
    const centered = { textAnchor: 'middle', dominantBaseline: 'middle' };
    expect(items).to.deep.equal([
      { x: 'A', y: 10, text: '10', style: centered },
      { x: 'B', y: 20, text: '20', style: centered },
    ]);
  });

  it('uses a constant value-def text for every row', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: { ...baseSpec.encoding, text: { value: 'fixed' } },
    });
    const items = textItems(compiled.overlays);
    const centered = { textAnchor: 'middle', dominantBaseline: 'middle' };
    expect(items).to.deep.equal([
      { x: 'A', y: 10, text: 'fixed', style: centered },
      { x: 'B', y: 20, text: 'fixed', style: centered },
    ]);
  });

  it('uses a constant datum-def text for every row', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: { ...baseSpec.encoding, text: { datum: 42 } },
    });
    const items = textItems(compiled.overlays);
    expect(items?.every((item) => item.text === '42')).to.equal(true);
  });

  it('applies mark.dx/dy as pixel offsets', () => {
    const compiled = compileSpec({
      ...baseSpec,
      mark: { type: 'text', dx: 4, dy: -6 },
    });
    const items = textItems(compiled.overlays);
    expect(items?.[0]).to.include({ dx: 4, dy: -6 });
  });

  it('maps mark.fontSize/font/fontWeight/color to style', () => {
    const compiled = compileSpec({
      ...baseSpec,
      mark: { type: 'text', fontSize: 14, font: 'Arial', fontWeight: 'bold', color: '#ff0000' },
    });
    const items = textItems(compiled.overlays);
    expect(items?.[0]?.style).to.deep.equal({
      fontSize: 14,
      fontFamily: 'Arial',
      fontWeight: 'bold',
      fill: '#ff0000',
      textAnchor: 'middle',
      dominantBaseline: 'middle',
    });
  });

  it('maps mark.align to textAnchor (left/center/right -> start/middle/end)', () => {
    const left = compileSpec({ ...baseSpec, mark: { type: 'text', align: 'left' } });
    const center = compileSpec({ ...baseSpec, mark: { type: 'text', align: 'center' } });
    const right = compileSpec({ ...baseSpec, mark: { type: 'text', align: 'right' } });
    expect(textItems(left.overlays)?.[0]?.style?.textAnchor).to.equal('start');
    expect(textItems(center.overlays)?.[0]?.style?.textAnchor).to.equal('middle');
    expect(textItems(right.overlays)?.[0]?.style?.textAnchor).to.equal('end');
  });

  it('maps mark.baseline to dominantBaseline (top/middle/bottom -> hanging/middle/auto)', () => {
    const top = compileSpec({ ...baseSpec, mark: { type: 'text', baseline: 'top' } });
    const middle = compileSpec({ ...baseSpec, mark: { type: 'text', baseline: 'middle' } });
    const bottom = compileSpec({ ...baseSpec, mark: { type: 'text', baseline: 'bottom' } });
    expect(textItems(top.overlays)?.[0]?.style?.dominantBaseline).to.equal('hanging');
    expect(textItems(middle.overlays)?.[0]?.style?.dominantBaseline).to.equal('middle');
    expect(textItems(bottom.overlays)?.[0]?.style?.dominantBaseline).to.equal('auto');
  });

  it('applies a translatable `format` d3 pattern to the text field (no gap)', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: {
        ...baseSpec.encoding,
        text: { field: 'amount', type: 'quantitative', format: '.2f' },
      },
    });
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('encoding:text-format');
    const items = textItems(compiled.overlays);
    expect(items?.[0]?.text).to.equal('10.00');
    expect(items?.[1]?.text).to.equal('20.00');
  });

  it('reports a partial gap and falls back to the raw value for an untranslatable format', () => {
    const compiled = compileSpec({
      ...baseSpec,
      // A nominal field with no explicit formatType cannot pick a d3 formatter.
      encoding: {
        ...baseSpec.encoding,
        text: { field: 'category', type: 'nominal', format: '.2f' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'encoding:text-format');
    expect(gap?.severity).to.equal('partial');
    const items = textItems(compiled.overlays);
    expect(items?.[0]?.text).to.equal('A');
  });

  it('resolves a test-predicate text condition per row (no text-condition gap)', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: {
        ...baseSpec.encoding,
        text: { field: 'amount', condition: { test: 'datum.amount > 15', value: 'BIG' } },
      },
    });
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('encoding:text-condition');
    const items = textItems(compiled.overlays);
    expect(items?.[0]?.text).to.equal('10');
    expect(items?.[1]?.text).to.equal('BIG');
  });

  it('picks the first matching entry from a condition array', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: {
        ...baseSpec.encoding,
        text: {
          field: 'amount',
          condition: [
            { test: 'datum.amount > 50', value: 'HUGE' },
            { test: 'datum.amount > 15', value: 'BIG' },
          ],
        },
      },
    });
    const items = textItems(compiled.overlays);
    expect(items?.map((item) => item.text)).to.deep.equal(['10', 'BIG']);
  });

  it('reports encoding:condition-param and uses the base value for a param-ref condition', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: {
        ...baseSpec.encoding,
        text: { field: 'amount', condition: { param: 'sel', value: 'X' } },
      },
    });
    expect(compiled.gaps.map((entry) => entry.code)).to.include('encoding:condition-param');
    const items = textItems(compiled.overlays);
    expect(items?.[0]?.text).to.equal('10');
  });

  it('reports encoding:condition-test for an unparseable condition test', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: {
        ...baseSpec.encoding,
        text: { field: 'amount', condition: { test: 'datum.amount >>> 5', value: 'X' } },
      },
    });
    expect(compiled.gaps.map((entry) => entry.code)).to.include('encoding:condition-test');
  });

  it('reports an unsupported gap and drops the layer when the text channel is missing', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: 'text',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:text-missing-channel');
    expect(gap?.severity).to.equal('unsupported');
    expect(compiled.overlays).to.have.length(0);
  });

  it('reports an unsupported gap and drops the layer when a positional channel is missing', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: 'text',
      encoding: {
        x: { field: 'category', type: 'nominal' },
        text: { field: 'amount' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:text-missing-axis');
    expect(gap?.severity).to.equal('unsupported');
    expect(compiled.overlays).to.have.length(0);
  });

  it('skips rows whose text field value is null/undefined', () => {
    const compiled = compileSpec({
      ...baseSpec,
      data: {
        values: [
          { category: 'A', amount: 10 },
          { category: 'B', amount: null },
        ],
      },
    });
    const items = textItems(compiled.overlays);
    expect(items).to.have.length(1);
  });

  it('positions labels against a temporal axis using coerced Date values, mirroring point.ts', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { day: '2020-01-01', value: 3 },
          { day: '2020-01-02', value: 7 },
        ],
      },
      mark: 'text',
      encoding: {
        x: { field: 'day', type: 'temporal' },
        y: { field: 'value', type: 'quantitative' },
        text: { field: 'value' },
      },
    });
    const items = textItems(compiled.overlays);
    expect(items?.[0]?.x).to.be.instanceOf(Date);
  });
});
