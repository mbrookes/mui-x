import { createIsHighlighted, createIsFaded } from './highlight';

describe('Choropleth highlight - createIsHighlighted', () => {
  const highlightedItem = { seriesId: 'series-1', featureId: 'US' };

  it('should return false for all items when no highlightScope provided', () => {
    const isHighlighted = createIsHighlighted(null, highlightedItem);
    expect(isHighlighted({ seriesId: 'series-1', featureId: 'US' })).to.equal(false);
  });

  it('should return false for all items when no highlightedItem provided', () => {
    const isHighlighted = createIsHighlighted({ highlight: 'item', fade: 'global' }, null);
    expect(isHighlighted({ seriesId: 'series-1', featureId: 'US' })).to.equal(false);
  });

  it('should highlight items in the same series when highlight is "series"', () => {
    const isHighlighted = createIsHighlighted(
      { highlight: 'series', fade: 'global' },
      highlightedItem,
    );
    expect(isHighlighted({ seriesId: 'series-1', featureId: 'CA' })).to.equal(true);
    expect(isHighlighted({ seriesId: 'series-2', featureId: 'US' })).to.equal(false);
  });

  it('should highlight only the exact item when highlight is "item"', () => {
    const isHighlighted = createIsHighlighted(
      { highlight: 'item', fade: 'global' },
      highlightedItem,
    );
    expect(isHighlighted({ seriesId: 'series-1', featureId: 'US' })).to.equal(true);
    expect(isHighlighted({ seriesId: 'series-1', featureId: 'CA' })).to.equal(false);
    expect(isHighlighted({ seriesId: 'series-2', featureId: 'US' })).to.equal(false);
  });
});

describe('Choropleth highlight - createIsFaded', () => {
  const highlightedItem = { seriesId: 'series-1', featureId: 'US' };

  it('should return false for all items when no highlightScope provided', () => {
    const isFaded = createIsFaded(null, highlightedItem);
    expect(isFaded({ seriesId: 'series-1', featureId: 'US' })).to.equal(false);
  });

  it('should fade items in same series with different featureId when fade is "series"', () => {
    const isFaded = createIsFaded({ highlight: 'item', fade: 'series' }, highlightedItem);
    expect(isFaded({ seriesId: 'series-1', featureId: 'CA' })).to.equal(true);
    expect(isFaded({ seriesId: 'series-1', featureId: 'US' })).to.equal(false);
    expect(isFaded({ seriesId: 'series-2', featureId: 'CA' })).to.equal(false);
  });

  it('should fade all items except the highlighted one when fade is "global"', () => {
    const isFaded = createIsFaded({ highlight: 'item', fade: 'global' }, highlightedItem);
    expect(isFaded({ seriesId: 'series-1', featureId: 'US' })).to.equal(false);
    expect(isFaded({ seriesId: 'series-1', featureId: 'CA' })).to.equal(true);
    expect(isFaded({ seriesId: 'series-2', featureId: 'US' })).to.equal(true);
  });
});
