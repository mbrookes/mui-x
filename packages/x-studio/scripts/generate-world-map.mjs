/**
 * Generates `src/StudioMapWidget/countryPaths.ts` from the Natural Earth 110m world-atlas TopoJSON.
 *
 * Data source: https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json
 * License: Public Domain (Natural Earth data)
 *
 * Usage: node scripts/generate-world-map.mjs
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 500;

// ISO 3166-1 numeric → alpha-2 mapping (complete list)
const NUMERIC_TO_ALPHA2 = {
  4: 'AF', 8: 'AL', 12: 'DZ', 16: 'AS', 20: 'AD', 24: 'AO', 28: 'AG', 32: 'AR',
  36: 'AU', 40: 'AT', 44: 'BS', 48: 'BH', 50: 'BD', 51: 'AM', 52: 'BB', 56: 'BE',
  60: 'BM', 64: 'BT', 68: 'BO', 70: 'BA', 72: 'BW', 76: 'BR', 84: 'BZ', 90: 'SB',
  96: 'BN', 100: 'BG', 104: 'MM', 108: 'BI', 112: 'BY', 116: 'KH', 120: 'CM',
  124: 'CA', 132: 'CV', 140: 'CF', 144: 'LK', 148: 'TD', 152: 'CL', 156: 'CN',
  158: 'TW', 170: 'CO', 174: 'KM', 178: 'CG', 180: 'CD', 188: 'CR', 191: 'HR',
  192: 'CU', 196: 'CY', 203: 'CZ', 204: 'BJ', 208: 'DK', 212: 'DM', 214: 'DO',
  218: 'EC', 222: 'SV', 226: 'GQ', 231: 'ET', 232: 'ER', 233: 'EE', 238: 'FK',
  242: 'FJ', 246: 'FI', 250: 'FR', 260: 'TF', 262: 'DJ', 266: 'GA', 268: 'GE',
  270: 'GM', 275: 'PS', 276: 'DE', 288: 'GH', 300: 'GR', 304: 'GL', 308: 'GD',
  320: 'GT', 324: 'GN', 328: 'GY', 332: 'HT', 340: 'HN', 348: 'HU', 352: 'IS',
  356: 'IN', 360: 'ID', 364: 'IR', 368: 'IQ', 372: 'IE', 376: 'IL', 380: 'IT',
  384: 'CI', 388: 'JM', 392: 'JP', 398: 'KZ', 400: 'JO', 404: 'KE', 408: 'KP',
  410: 'KR', 414: 'KW', 417: 'KG', 418: 'LA', 422: 'LB', 426: 'LS', 428: 'LV',
  430: 'LR', 434: 'LY', 440: 'LT', 442: 'LU', 450: 'MG', 454: 'MW', 458: 'MY',
  462: 'MV', 466: 'ML', 474: 'MQ', 478: 'MR', 480: 'MU', 484: 'MX', 496: 'MN',
  498: 'MD', 499: 'ME', 504: 'MA', 508: 'MZ', 512: 'OM', 516: 'NA', 524: 'NP',
  528: 'NL', 548: 'VU', 554: 'NZ', 558: 'NI', 562: 'NE', 566: 'NG', 578: 'NO',
  586: 'PK', 591: 'PA', 598: 'PG', 600: 'PY', 604: 'PE', 608: 'PH', 616: 'PL',
  620: 'PT', 624: 'GW', 626: 'TL', 630: 'PR', 634: 'QA', 642: 'RO', 643: 'RU',
  646: 'RW', 659: 'KN', 662: 'LC', 670: 'VC', 678: 'ST', 682: 'SA', 686: 'SN',
  688: 'RS', 690: 'SC', 694: 'SL', 703: 'SK', 704: 'VN', 705: 'SI', 706: 'SO',
  710: 'ZA', 716: 'ZW', 724: 'ES', 728: 'SS', 729: 'SD', 732: 'EH', 740: 'SR',
  748: 'SZ', 752: 'SE', 756: 'CH', 760: 'SY', 762: 'TJ', 764: 'TH', 768: 'TG',
  780: 'TT', 784: 'AE', 788: 'TN', 792: 'TR', 795: 'TM', 800: 'UG', 804: 'UA',
  807: 'MK', 818: 'EG', 826: 'GB', 834: 'TZ', 840: 'US', 854: 'BF', 858: 'UY',
  860: 'UZ', 862: 'VE', 887: 'YE', 894: 'ZM',
  // Antarctica (optional — included for completeness)
  10: 'AQ',
  // Additional territories
  31: 'AZ',
  540: 'NC',
};

/**
 * Decode a TopoJSON arc to geographic [lon, lat] coordinates.
 */
function decodeArc(arc, transform) {
  const { scale, translate } = transform;
  let qx = 0;
  let qy = 0;
  return arc.map(([dx, dy]) => {
    qx += dx;
    qy += dy;
    return [qx * scale[0] + translate[0], qy * scale[1] + translate[1]];
  });
}

/**
 * Convert [lon, lat] to SVG [x, y] with equirectangular projection.
 */
function project([lon, lat]) {
  const x = ((lon + 180) / 360) * VIEW_WIDTH;
  const y = ((90 - lat) / 180) * VIEW_HEIGHT;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

/**
 * Convert a sequence of [lon, lat] points to an SVG path segment (one ring).
 */
function ringToPathSegment(points) {
  if (points.length === 0) return '';
  const [sx, sy] = project(points[0]);
  const rest = points
    .slice(1)
    .map((pt) => {
      const [px, py] = project(pt);
      return `L${px},${py}`;
    })
    .join('');
  return `M${sx},${sy}${rest}Z`;
}

/**
 * Resolve an arc index (positive = forward, negative = reversed) to geographic points.
 */
function resolveArc(arcIdx, arcs, transform) {
  if (arcIdx >= 0) {
    return decodeArc(arcs[arcIdx], transform);
  }
  // Reversed arc: ~arcIdx = -(arcIdx + 1)
  const decoded = decodeArc(arcs[~arcIdx], transform);
  return decoded.reverse();
}

/**
 * Build a ring (sequence of geographic points) from an array of arc indices.
 */
function buildRing(arcIndices, arcs, transform) {
  const points = [];
  for (const idx of arcIndices) {
    const segment = resolveArc(idx, arcs, transform);
    // Avoid duplicating the join point between consecutive arcs
    if (points.length > 0 && segment.length > 0) {
      points.push(...segment.slice(1));
    } else {
      points.push(...segment);
    }
  }
  return points;
}

/**
 * Convert a TopoJSON geometry to an SVG path `d` string.
 */
function geometryToPath(geometry, arcs, transform) {
  const segments = [];

  function processRings(rings) {
    for (const ring of rings) {
      const points = buildRing(ring, arcs, transform);
      const segment = ringToPathSegment(points);
      if (segment) segments.push(segment);
    }
  }

  if (geometry.type === 'Polygon') {
    processRings(geometry.arcs);
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.arcs) {
      processRings(polygon);
    }
  }

  return segments.join('');
}

async function main() {
  console.log('Fetching world-atlas 110m TopoJSON...');
  const response = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
  const topo = await response.json();

  const { transform, arcs, objects } = topo;
  const geometries = objects.countries.geometries;

  const countryPaths = {};
  const unmapped = [];

  for (const geometry of geometries) {
    const numericId = parseInt(geometry.id, 10);

    // Skip geometries with unparseable IDs (e.g. undefined or non-numeric)
    if (isNaN(numericId)) continue;

    const alpha2 = NUMERIC_TO_ALPHA2[numericId];

    if (!alpha2) {
      unmapped.push(numericId);
      continue;
    }

    const pathD = geometryToPath(geometry, arcs, transform);
    if (pathD) {
      countryPaths[alpha2] = pathD;
    }
  }

  if (unmapped.length > 0) {
    console.warn('Unmapped numeric IDs (may need adding to lookup table):', unmapped);
  }

  console.log(`Generated paths for ${Object.keys(countryPaths).length} countries.`);

  // Build the TypeScript file
  const entries = Object.entries(countryPaths)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, d]) => `  ${JSON.stringify(code)}: ${JSON.stringify(d)},`)
    .join('\n');

  const output = `/**
 * World country SVG paths (equirectangular projection, 960×500 viewBox).
 *
 * Generated from Natural Earth 110m world-atlas TopoJSON (public domain).
 * Run \`node packages/x-studio/scripts/generate-world-map.mjs\` to regenerate.
 *
 * Keys are ISO 3166-1 alpha-2 country codes.
 */
// prettier-ignore
export const COUNTRY_PATHS: Record<string, string> = {
${entries}
};
`;

  const outPath = join(__dirname, '../src/StudioMapWidget/countryPaths.ts');
  writeFileSync(outPath, output, 'utf8');
  console.log(`Written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
