/**
 * Normalizes country identifiers (ISO alpha-2, alpha-3, full name, or common alias)
 * to ISO 3166-1 alpha-2 codes for lookup in the world map.
 *
 * Normalization is deterministic — no fuzzy matching.
 */

/** ISO alpha-3 → alpha-2 mapping for the ~195 UN member states. */
const ALPHA3_TO_ALPHA2: Record<string, string> = {
  AFG: 'AF', ALB: 'AL', DZA: 'DZ', AND: 'AD', AGO: 'AO', ATG: 'AG', ARG: 'AR',
  ARM: 'AM', AUS: 'AU', AUT: 'AT', AZE: 'AZ', BHS: 'BS', BHR: 'BH', BGD: 'BD',
  BRB: 'BB', BLR: 'BY', BEL: 'BE', BLZ: 'BZ', BEN: 'BJ', BTN: 'BT', BOL: 'BO',
  BIH: 'BA', BWA: 'BW', BRA: 'BR', BRN: 'BN', BGR: 'BG', BFA: 'BF', BDI: 'BI',
  CPV: 'CV', KHM: 'KH', CMR: 'CM', CAN: 'CA', CAF: 'CF', TCD: 'TD', CHL: 'CL',
  CHN: 'CN', COL: 'CO', COM: 'KM', COD: 'CD', COG: 'CG', CRI: 'CR', CIV: 'CI',
  HRV: 'HR', CUB: 'CU', CYP: 'CY', CZE: 'CZ', DNK: 'DK', DJI: 'DJ', DOM: 'DO',
  ECU: 'EC', EGY: 'EG', SLV: 'SV', GNQ: 'GQ', ERI: 'ER', EST: 'EE', ETH: 'ET',
  FJI: 'FJ', FIN: 'FI', FRA: 'FR', GAB: 'GA', GMB: 'GM', GEO: 'GE', DEU: 'DE',
  GHA: 'GH', GRC: 'GR', GRD: 'GD', GTM: 'GT', GIN: 'GN', GNB: 'GW', GUY: 'GY',
  HTI: 'HT', HND: 'HN', HUN: 'HU', ISL: 'IS', IND: 'IN', IDN: 'ID', IRN: 'IR',
  IRQ: 'IQ', IRL: 'IE', ISR: 'IL', ITA: 'IT', JAM: 'JM', JPN: 'JP', JOR: 'JO',
  KAZ: 'KZ', KEN: 'KE', PRK: 'KP', KOR: 'KR', KWT: 'KW', KGZ: 'KG', LAO: 'LA',
  LVA: 'LV', LBN: 'LB', LSO: 'LS', LBR: 'LR', LBY: 'LY', LTU: 'LT', LUX: 'LU',
  MDG: 'MG', MWI: 'MW', MYS: 'MY', MDV: 'MV', MLI: 'ML', MRT: 'MR', MUS: 'MU',
  MEX: 'MX', MNG: 'MN', MNE: 'ME', MAR: 'MA', MOZ: 'MZ', MMR: 'MM', NAM: 'NA',
  NPL: 'NP', NLD: 'NL', NZL: 'NZ', NIC: 'NI', NER: 'NE', NGA: 'NG', MKD: 'MK',
  NOR: 'NO', OMN: 'OM', PAK: 'PK', PAN: 'PA', PNG: 'PG', PRY: 'PY', PER: 'PE',
  PHL: 'PH', POL: 'PL', PRT: 'PT', QAT: 'QA', ROU: 'RO', RUS: 'RU', RWA: 'RW',
  KNA: 'KN', LCA: 'LC', VCT: 'VC', WSM: 'WS', STP: 'ST', SAU: 'SA', SEN: 'SN',
  SRB: 'RS', SLE: 'SL', SGP: 'SG', SVK: 'SK', SVN: 'SI', SLB: 'SB', SOM: 'SO',
  ZAF: 'ZA', SSD: 'SS', ESP: 'ES', LKA: 'LK', SDN: 'SD', SUR: 'SR', SWZ: 'SZ',
  SWE: 'SE', CHE: 'CH', SYR: 'SY', TWN: 'TW', TJK: 'TJ', TZA: 'TZ', THA: 'TH',
  TLS: 'TL', TGO: 'TG', TTO: 'TT', TUN: 'TN', TUR: 'TR', TKM: 'TM', UGA: 'UG',
  UKR: 'UA', ARE: 'AE', GBR: 'GB', USA: 'US', URY: 'UY', UZB: 'UZ', VUT: 'VU',
  VEN: 'VE', VNM: 'VN', YEM: 'YE', ZMB: 'ZM', ZWE: 'ZW', DMA: 'DM', SYC: 'SC',
  MDV_: 'MV',
};

/** Common English country name / alias → alpha-2 mapping. */
const NAME_TO_ALPHA2: Record<string, string> = {
  'afghanistan': 'AF', 'albania': 'AL', 'algeria': 'DZ', 'angola': 'AO',
  'argentina': 'AR', 'armenia': 'AM', 'australia': 'AU', 'austria': 'AT',
  'azerbaijan': 'AZ', 'bahamas': 'BS', 'bahrain': 'BH', 'bangladesh': 'BD',
  'barbados': 'BB', 'belarus': 'BY', 'belgium': 'BE', 'belize': 'BZ',
  'benin': 'BJ', 'bhutan': 'BT', 'bolivia': 'BO', 'bosnia': 'BA',
  'bosnia and herzegovina': 'BA', 'botswana': 'BW', 'brazil': 'BR',
  'brunei': 'BN', 'bulgaria': 'BG', 'burkina faso': 'BF', 'burundi': 'BI',
  'cabo verde': 'CV', 'cape verde': 'CV', 'cambodia': 'KH', 'cameroon': 'CM',
  'canada': 'CA', 'central african republic': 'CF', 'chad': 'TD', 'chile': 'CL',
  'china': 'CN', 'colombia': 'CO', 'comoros': 'KM', 'congo': 'CG',
  'dr congo': 'CD', 'democratic republic of the congo': 'CD',
  'republic of the congo': 'CG', 'costa rica': 'CR', "ivory coast": 'CI',
  "cote d'ivoire": 'CI', 'croatia': 'HR', 'cuba': 'CU', 'cyprus': 'CY',
  'czech republic': 'CZ', 'czechia': 'CZ', 'denmark': 'DK', 'djibouti': 'DJ',
  'dominican republic': 'DO', 'ecuador': 'EC', 'egypt': 'EG', 'el salvador': 'SV',
  'equatorial guinea': 'GQ', 'eritrea': 'ER', 'estonia': 'EE', 'eswatini': 'SZ',
  'swaziland': 'SZ', 'ethiopia': 'ET', 'fiji': 'FJ', 'finland': 'FI',
  'france': 'FR', 'gabon': 'GA', 'gambia': 'GM', 'georgia': 'GE',
  'germany': 'DE', 'ghana': 'GH', 'greece': 'GR', 'grenada': 'GD',
  'guatemala': 'GT', 'guinea': 'GN', 'guinea-bissau': 'GW', 'guyana': 'GY',
  'haiti': 'HT', 'honduras': 'HN', 'hungary': 'HU', 'iceland': 'IS',
  'india': 'IN', 'indonesia': 'ID', 'iran': 'IR', 'iraq': 'IQ',
  'ireland': 'IE', 'israel': 'IL', 'italy': 'IT', 'jamaica': 'JM',
  'japan': 'JP', 'jordan': 'JO', 'kazakhstan': 'KZ', 'kenya': 'KE',
  'north korea': 'KP', 'south korea': 'KR', 'korea': 'KR', 'kuwait': 'KW',
  'kyrgyzstan': 'KG', 'laos': 'LA', 'latvia': 'LV', 'lebanon': 'LB',
  'lesotho': 'LS', 'liberia': 'LR', 'libya': 'LY', 'lithuania': 'LT',
  'luxembourg': 'LU', 'madagascar': 'MG', 'malawi': 'MW', 'malaysia': 'MY',
  'maldives': 'MV', 'mali': 'ML', 'mauritania': 'MR', 'mauritius': 'MU',
  'mexico': 'MX', 'moldova': 'MD', 'mongolia': 'MN', 'montenegro': 'ME',
  'morocco': 'MA', 'mozambique': 'MZ', 'myanmar': 'MM', 'burma': 'MM',
  'namibia': 'NA', 'nepal': 'NP', 'netherlands': 'NL', 'new zealand': 'NZ',
  'nicaragua': 'NI', 'niger': 'NE', 'nigeria': 'NG', 'north macedonia': 'MK',
  'macedonia': 'MK', 'norway': 'NO', 'oman': 'OM', 'pakistan': 'PK',
  'panama': 'PA', 'papua new guinea': 'PG', 'paraguay': 'PY', 'peru': 'PE',
  'philippines': 'PH', 'poland': 'PL', 'portugal': 'PT', 'qatar': 'QA',
  'romania': 'RO', 'russia': 'RU', 'russian federation': 'RU', 'rwanda': 'RW',
  'saudi arabia': 'SA', 'senegal': 'SN', 'serbia': 'RS', 'sierra leone': 'SL',
  'singapore': 'SG', 'slovakia': 'SK', 'slovenia': 'SI', 'solomon islands': 'SB',
  'somalia': 'SO', 'south africa': 'ZA', 'south sudan': 'SS', 'spain': 'ES',
  'sri lanka': 'LK', 'sudan': 'SD', 'suriname': 'SR', 'sweden': 'SE',
  'switzerland': 'CH', 'syria': 'SY', 'taiwan': 'TW', 'tajikistan': 'TJ',
  'tanzania': 'TZ', 'thailand': 'TH', 'timor-leste': 'TL', 'east timor': 'TL',
  'togo': 'TG', 'trinidad and tobago': 'TT', 'tunisia': 'TN', 'turkey': 'TR',
  'turkmenistan': 'TM', 'uganda': 'UG', 'ukraine': 'UA',
  'united arab emirates': 'AE', 'uae': 'AE',
  'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB',
  'united states': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
  'united states of america': 'US',
  'uruguay': 'UY', 'uzbekistan': 'UZ', 'vanuatu': 'VU', 'venezuela': 'VE',
  'vietnam': 'VN', 'viet nam': 'VN', 'yemen': 'YE', 'zambia': 'ZM',
  'zimbabwe': 'ZW',
};

/**
 * Normalizes a country identifier string to ISO 3166-1 alpha-2.
 *
 * Handles:
 * - ISO alpha-2 codes ("US", "gb", "de")
 * - ISO alpha-3 codes ("USA", "GBR", "DEU")
 * - Common English country names ("United States", "Germany")
 * - Some common aliases ("America", "UK")
 *
 * Returns the alpha-2 code (upper-case) or `null` if unknown.
 */
export function normalizeToAlpha2(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();

  // Already alpha-2?
  if (upper.length === 2) {
    // Basic sanity: alpha-2 codes are letters only
    if (/^[A-Z]{2}$/.test(upper)) return upper;
  }

  // Alpha-3?
  if (upper.length === 3 && /^[A-Z]{3}$/.test(upper)) {
    const a2 = ALPHA3_TO_ALPHA2[upper];
    if (a2) return a2;
  }

  // Full name / alias lookup (case-insensitive)
  const fromName = NAME_TO_ALPHA2[lower];
  if (fromName) return fromName;

  return null;
}
