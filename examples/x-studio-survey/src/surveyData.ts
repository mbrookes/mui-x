/**
 * Loads the two survey spreadsheets through the generic Excel adapter
 * (`connectors/excelAdapter.ts`) and exposes them as x-studio data sources.
 *
 * The spreadsheet paths are hardcoded to files served from `public/data/`.
 * Each workbook contributes one data source per sheet, all served by that
 * workbook's single shared adapter.
 *
 * A small, report-specific `enrichSource` pass tags a handful of rating /
 * ordinal fields so the survey charts render with sensible category ordering
 * and treat 1–10 / 1–5 ratings as categories rather than continuous measures.
 * The adapter itself stays schema-agnostic.
 */
import type { StudioDataSource } from '@mui/x-studio';
import { loadExcelWorkbook } from './connectors/excelAdapter';

// Hardcoded spreadsheet locations (served from public/data).
export const SURVEY_2025_URL = `${import.meta.env.BASE_URL}data/survey2025.xlsx`;
export const SURVEY_2023_URL = `${import.meta.env.BASE_URL}data/survey2023.xlsx`;

/** The primary 2025 responses sheet — the source every report widget reads from. */
export const SURVEY_2025_SOURCE_ID = 'survey-2025-sheet1';

/** Field ids (slugified question text) used by the report config. */
export const FIELDS = {
  submissionId: 'submission-id',
  source: 'source',
  stylingHandling: 'how-would-you-prefer-your-component-library-to-handle-styling',
  stylingSolution: 'what-styling-solution-do-you-prefer-using',
  richDefaults:
    'rate-the-statement-i-like-having-rich-defaults-and-out-of-the-box-features-even-if-customization-is-limited',
  wrapMui: 'do-you-wrap-material-ui-inside-your-own-component-library',
  docsSetup: 'which-documentation-setup-does-your-team-primarily-use',
  plan: 'which-mui-x-plan-are-you-using',
  commercialHappiness: 'how-happy-are-you-winth-the-commercial-components',
  usingCharts: 'are-you-using-mui-x-charts',
  aiUsage: 'on-a-scale-from-1-to-10-how-would-rate-how-often-do-you-use-ai-in-front-end-work',
  profJs: 'how-proficient-are-you-in-the-following-technologies-javascript',
  profReact: 'how-proficient-are-you-in-the-following-technologies-react',
  profCss: 'how-proficient-are-you-in-the-following-technologies-css',
  profMui: 'how-proficient-are-you-in-the-following-technologies-mui-libraries',
  muiDevs: 'how-many-developers-are-using-mui-at-your-company',
  companyDevs: 'how-many-developers-work-at-your-company',
  roles: 'which-role-s-best-describe-you',
  heardAbout: 'where-did-you-first-hear-about-mui',
} as const;

/** Beginner → expert proficiency scale, for canonical chart ordering. */
const PROFICIENCY_ORDER = [
  "I'm a beginner. Getting started",
  "I'm intermediate. I'm competent with it.",
  "I'm advanced. I'm proficient.",
  "I'm an expert. I have subject matter authority.",
];

/** Company-size buckets, smallest → largest. */
const SIZE_ORDER = ['Only me', '2–5', '6–10', '11–25', '26–50', '51–200', '201–500', '500+'];

/** Numeric rating fields that should be charted as discrete categories. */
const RATING_FIELD_IDS = new Set<string>([FIELDS.richDefaults, FIELDS.commercialHappiness, FIELDS.aiUsage]);

const PROFICIENCY_FIELD_IDS = new Set<string>([
  FIELDS.profJs,
  FIELDS.profReact,
  FIELDS.profCss,
  FIELDS.profMui,
]);

const SIZE_FIELD_IDS = new Set<string>([FIELDS.muiDevs, FIELDS.companyDevs]);

/**
 * Report-specific tweaks to the inferred fields of the primary 2025 sheet.
 * Mutates field metadata in place; does not touch the generic adapter output
 * for any other source.
 */
function enrichSource(source: StudioDataSource): void {
  if (source.id !== SURVEY_2025_SOURCE_ID) {
    return;
  }
  for (const field of source.fields) {
    if (RATING_FIELD_IDS.has(field.id)) {
      // Treat the rating number as a category so charts bucket per score.
      field.capabilities = ['categorical'];
    } else if (PROFICIENCY_FIELD_IDS.has(field.id)) {
      field.orderedValues = PROFICIENCY_ORDER;
    } else if (SIZE_FIELD_IDS.has(field.id)) {
      field.orderedValues = SIZE_ORDER;
    }
  }
}

export interface LoadedSurvey {
  dataSources: Record<string, StudioDataSource>;
  /** Adapter wiring — one shared adapter per workbook, applied to its sheets. */
  adapters: { sourceId: string; adapter: import('@mui/x-studio').StudioDataSourceAdapter }[];
}

/** Fetch + parse both workbooks and return ready-to-use data sources and adapters. */
export async function loadSurveyWorkbooks(): Promise<LoadedSurvey> {
  const [wb2025, wb2023] = await Promise.all([
    loadExcelWorkbook(SURVEY_2025_URL, { idPrefix: 'survey-2025', labelPrefix: '2025 Survey' }),
    loadExcelWorkbook(SURVEY_2023_URL, { idPrefix: 'survey-2023', labelPrefix: '2023 Survey' }),
  ]);

  const dataSources: Record<string, StudioDataSource> = {};
  const adapters: LoadedSurvey['adapters'] = [];

  for (const workbook of [wb2025, wb2023]) {
    for (const source of workbook.sources) {
      enrichSource(source);
      dataSources[source.id] = source;
      adapters.push({ sourceId: source.id, adapter: workbook.adapter });
    }
  }

  return { dataSources, adapters };
}
