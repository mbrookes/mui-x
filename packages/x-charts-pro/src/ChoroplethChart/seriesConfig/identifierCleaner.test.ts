import identifierCleaner from './identifierCleaner';

describe('Choropleth identifierCleaner', () => {
  it('should clean a choropleth identifier', () => {
    const identifier = {
      type: 'choropleth',
      seriesId: 'test-choropleth',
      featureId: 'feature-42',
      extraProp: 'should be removed',
    } as const;

    const cleaned = identifierCleaner(identifier);

    expect(cleaned).to.deep.equal({
      type: 'choropleth',
      seriesId: 'test-choropleth',
      featureId: 'feature-42',
    });
  });

  it('should not include extra properties', () => {
    const identifier = {
      type: 'choropleth',
      seriesId: 'series-1',
      featureId: 'US',
    } as const;

    const cleaned = identifierCleaner(identifier);

    expect(Object.keys(cleaned)).to.deep.equal(['type', 'seriesId', 'featureId']);
  });
});
