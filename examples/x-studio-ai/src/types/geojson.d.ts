declare namespace GeoJSON {
  interface GeoJsonObject {
    type: string;
  }

  interface Geometry extends GeoJsonObject {
    coordinates?: unknown;
  }

  interface Feature<G extends Geometry = Geometry, P = Record<string, unknown>> extends GeoJsonObject {
    type: 'Feature';
    geometry: G | null;
    properties?: P;
    id?: string | number;
  }

  interface FeatureCollection<G extends Geometry = Geometry, P = Record<string, unknown>>
    extends GeoJsonObject {
    type: 'FeatureCollection';
    features: Array<Feature<G, P>>;
  }
}
