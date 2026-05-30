import identifierSerializer from './identifierSerializer';

describe('Choropleth identifierSerializer', () => {
  it('should serialize a choropleth identifier', () => {
    const identifier = {
      type: 'choropleth' as const,
      seriesId: 'series-1',
      featureId: 'US',
    };

    const serialized = identifierSerializer(identifier);

    expect(serialized).to.equal('Type(choropleth)Series(series-1)F(US)');
  });

  it('should produce different strings for different featureIds', () => {
    const id1 = identifierSerializer({ type: 'choropleth', seriesId: 's1', featureId: 'US' });
    const id2 = identifierSerializer({ type: 'choropleth', seriesId: 's1', featureId: 'CA' });

    expect(id1).not.to.equal(id2);
  });

  it('should produce different strings for different seriesIds', () => {
    const id1 = identifierSerializer({ type: 'choropleth', seriesId: 's1', featureId: 'US' });
    const id2 = identifierSerializer({ type: 'choropleth', seriesId: 's2', featureId: 'US' });

    expect(id1).not.to.equal(id2);
  });
});
