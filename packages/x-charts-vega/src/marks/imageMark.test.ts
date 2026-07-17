import { compileSpec } from '../compile';
import type { VegaLiteSpec } from '../types';
import type { CompiledOverlay } from '../compile/context';

function imageItems(overlays: CompiledOverlay[]) {
  const overlay = overlays.find((entry) => entry.kind === 'image');
  return overlay && overlay.kind === 'image' ? overlay.items : undefined;
}

describe('compileImageMark', () => {
  const rows = [
    { x: 1, y: 1, icon: 'https://example.com/a.png' },
    { x: 2, y: 2, icon: 'https://example.com/b.png' },
  ];

  const baseSpec: VegaLiteSpec = {
    data: { values: rows },
    mark: 'image',
    encoding: {
      x: { field: 'x', type: 'quantitative' },
      y: { field: 'y', type: 'quantitative' },
      url: { field: 'icon' },
    } as VegaLiteSpec['encoding'],
  };

  it('produces an image overlay with one item per row, reading url from the field', () => {
    const compiled = compileSpec(baseSpec);
    expect(compiled.plots).to.deep.equal([]);
    const items = imageItems(compiled.overlays);
    expect(items).to.deep.equal([
      { x: 1, y: 1, url: 'https://example.com/a.png', width: 20, height: 20 },
      { x: 2, y: 2, url: 'https://example.com/b.png', width: 20, height: 20 },
    ]);
  });

  it('uses a constant value-def url for every row', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: { ...baseSpec.encoding, url: { value: 'https://example.com/static.png' } },
    });
    const items = imageItems(compiled.overlays);
    expect(items?.every((item) => item.url === 'https://example.com/static.png')).to.equal(true);
  });

  it('applies mark.width/mark.height, defaulting to 20 when unset', () => {
    const compiled = compileSpec({
      ...baseSpec,
      mark: { type: 'image', width: 32, height: 40 },
    });
    const items = imageItems(compiled.overlays);
    expect(items?.[0]).to.include({ width: 32, height: 40 });
  });

  it('preserves the aspect ratio by default (no gap, no item.aspect flag)', () => {
    const compiled = compileSpec({
      ...baseSpec,
      mark: { type: 'image', aspect: true },
    });
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('mark:image-aspect');
    const items = imageItems(compiled.overlays);
    expect(items?.[0]?.aspect).to.equal(undefined);
  });

  it('records item.aspect: false for aspect: false (stretch to width x height)', () => {
    const compiled = compileSpec({
      ...baseSpec,
      mark: { type: 'image', aspect: false },
    });
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('mark:image-aspect');
    const items = imageItems(compiled.overlays);
    expect(items?.[0]?.aspect).to.equal(false);
  });

  it('resolves a test-predicate url condition per row (no url-condition gap)', () => {
    const compiled = compileSpec({
      ...baseSpec,
      encoding: {
        ...baseSpec.encoding,
        url: {
          field: 'icon',
          condition: { test: 'datum.x > 1', value: 'https://example.com/big.png' },
        },
      } as VegaLiteSpec['encoding'],
    });
    expect(compiled.gaps.map((entry) => entry.code)).not.to.include('encoding:url-condition');
    const items = imageItems(compiled.overlays);
    expect(items?.[0]?.url).to.equal('https://example.com/a.png');
    expect(items?.[1]?.url).to.equal('https://example.com/big.png');
  });

  it('reports an unsupported gap and drops the layer when the url channel is missing', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: 'image',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:image-missing-url');
    expect(gap?.severity).to.equal('unsupported');
    expect(compiled.overlays).to.have.length(0);
  });

  it('reports an unsupported gap and drops the layer when a positional channel is missing', () => {
    const compiled = compileSpec({
      data: { values: rows },
      mark: 'image',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        url: { field: 'icon' },
      } as VegaLiteSpec['encoding'],
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:image-missing-axis');
    expect(gap?.severity).to.equal('unsupported');
    expect(compiled.overlays).to.have.length(0);
  });

  it('skips rows whose url field value is null/undefined', () => {
    const compiled = compileSpec({
      ...baseSpec,
      data: {
        values: [
          { x: 1, y: 1, icon: 'a.png' },
          { x: 2, y: 2, icon: null },
        ],
      },
    });
    const items = imageItems(compiled.overlays);
    expect(items).to.have.length(1);
  });

  it('reports an ignored x-charts-origin gap noting the custom-overlay rendering', () => {
    // x-charts has no image-mark primitive — always a custom overlay, a
    // legitimate x-charts limitation that must surface via onGaps.
    const compiled = compileSpec(baseSpec);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:image-custom-overlay');
    expect(gap?.severity).to.equal('ignored');
    expect(gap?.origin).to.equal('x-charts');
  });
});
