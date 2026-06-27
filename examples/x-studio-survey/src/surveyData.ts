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

/**
 * Field ids derived by slugifying each question's column header from the Excel export.
 * Q41 (email) is intentionally omitted.
 */
export const FIELDS = {
  submissionId: 'submission-id',
  source: 'source',
  // Q01
  stylingHandling: 'how-would-you-prefer-your-component-library-to-handle-styling',
  // Q02
  outsource:
    'which-parts-would-you-happily-outsource-to-the-library-vendor-instead-of-building-and-maintaining-them-yourself',
  // Q03
  stylingSolution: 'what-styling-solution-do-you-prefer-using',
  // Q04
  richDefaults:
    'rate-the-statement-i-like-having-rich-defaults-and-out-of-the-box-features-even-if-customization-is-limited',
  // Q05
  wrapMui: 'do-you-wrap-material-ui-inside-your-own-component-library',
  // Q06
  docsSetup: 'which-documentation-setup-does-your-team-primarily-use',
  // Q07
  wrapBenefit: 'what-s-the-benefit-you-get-from-wrapping-the-library',
  // Q07 — coded bins (G column)
  wrapBenefitG: 'g-what-s-the-benefit-you-get-from-wrapping-the-library',
  // Q08
  plan: 'which-mui-x-plan-are-you-using',
  // Q09 — note the "winth" typo is in the original column header
  commercialHappiness: 'how-happy-are-you-winth-the-commercial-components',
  // Q10
  backendServiceFactors:
    'when-considering-ui-components-that-rely-on-mui-backend-services-like-the-ai-assistant-what-are-the-factors-that-influence-your-decision-if-any',
  // Q10 — coded bins (G column)
  backendServiceFactorsG:
    'g-when-considering-ui-components-that-rely-on-mui-backend-services-like-the-ai-assistant-what-are-the-factors-that-influence-your-decision-if-any',
  // Q11
  advancedComponentsFeedback: 'which-advanced-components-are-you-interested-in-giving-feedback-on',
  // Q12
  schedulerMustHaves: 'which-scheduler-features-are-must-haves-for-you',
  // Q12 — coded bins (G column)
  schedulerMustHavesG: 'g-which-scheduler-features-are-must-haves-for-you',
  // Q13
  schedulerBackend: 'how-would-you-like-the-scheduler-to-handle-backend-and-integrations',
  // Q14
  schedulerAI: 'which-ai-features-would-be-most-useful-in-the-scheduler',
  // Q15
  chartingCriteria:
    'rank-the-following-criteria-by-their-importance-when-choosing-a-charting-library',
  // Q16
  usingCharts: 'are-you-using-mui-x-charts',
  // Q17
  chartsMigrationFrom: 'where-did-you-migrate-from-and-what-was-the-decisive-factor',
  // Q17 — coded bins (G column)
  chartsMigrationFromG: 'g-where-did-you-migrate-from-and-what-was-the-decisive-factor',
  // Q18
  chartsBlocker: 'what-s-stopping-you-from-using-mui-x-charts',
  // Q19
  chartsLibrary: 'which-charts-library-do-you-currently-use',
  // Q20
  chartsProSituation:
    'which-of-the-following-best-describes-your-situation-regarding-mui-x-charts-pro-premium',
  // Q21
  chartsNextFeatures: 'which-features-do-you-want-us-to-ship-next',
  // Q22
  chartsDatasetSize: 'what-s-your-typical-dataset-size',
  // Q23
  chartsBackendFeatures: 'which-backend-related-features-would-you-find-useful-for-charts',
  // Q24
  chartsAIFeatures: 'which-ai-powered-chart-features-would-help-you-most',
  // Q25
  ganttPrimaryUse: 'what-s-your-primary-use-for-gantt-charts',
  // Q26
  ganttFeature: 'what-one-feature-would-most-improve-your-gantt-workflow',
  // Q27
  ganttChallenges: 'what-top-challenges-do-you-face-with-your-gantt-solution',
  // Q28
  ganttAI: 'which-ai-features-would-be-most-helpful-for-planning',
  // Q29
  gridCriteria:
    'rank-the-following-criteria-by-their-importance-when-choosing-a-data-grid-component',
  // Q30
  gridUseCase: 'what-s-your-main-use-case-or-biggest-pain-point-with-data-grid',
  // Q30 — coded bins (G column)
  gridUseCaseG: 'g-what-s-your-main-use-case-or-biggest-pain-point-with-data-grid',
  // Q31
  gridDatasetSize: 'how-large-are-your-typical-data-grid-datasets',
  // Q32
  gridAIUseCases: 'which-ai-assistant-use-cases-are-you-interested-in',
  // Q33
  figmaKitUsage: 'have-you-or-anyone-in-your-team-used-the-mui-figma-kit',
  // Q34
  figmaKitMatch: 'how-well-does-the-figma-kit-match-the-components-you-implement-in-code',
  // Q35
  designDevHandoff: 'what-gets-in-the-way-during-design-development-hands-off',
  // Q35 — coded bins (G column; &gt; in original header → -gt- after slugify)
  designDevHandoffG: 'g-what-gets-in-the-way-during-design-gt-development-hands-off',
  // Q36
  figmaKitImprovement:
    'if-we-could-improve-one-thing-about-the-mui-figma-kit-what-should-it-be',
  // Q36 — coded bins (G column)
  figmaKitImprovementG:
    'g-if-we-could-improve-one-thing-about-the-mui-figma-kit-what-should-it-be',
  // Q37
  aiExperience:
    'describe-the-last-time-you-used-ai-with-any-mui-project-did-you-accomplish-your-goal-how-did-it-turn-out',
  // Q37 — coded bins (G column)
  aiExperienceG:
    'g-describe-the-last-time-you-used-ai-with-any-mui-project-did-you-accomplish-your-goal-how-did-it-turn-out',
  // Q38
  aiUsage: 'on-a-scale-from-1-to-10-how-would-rate-how-often-do-you-use-ai-in-front-end-work',
  // Q39
  aiWorkflow: 'where-does-ai-fit-into-your-workflow',
  // Q40
  aiTools: 'which-tools-or-services-are-involved-when-incorporating-ai-into-your-front-end-work',
  // Q40 — coded bins (G column)
  aiToolsG:
    'g-which-tools-or-services-are-involved-when-incorporating-ai-into-your-front-end-work',
  // Q41 (email) — omitted
  // Q42
  heardAbout: 'where-did-you-first-hear-about-mui',
  // Q43
  profJs: 'how-proficient-are-you-in-the-following-technologies-javascript',
  // Q44
  profReact: 'how-proficient-are-you-in-the-following-technologies-react',
  // Q45
  profCss: 'how-proficient-are-you-in-the-following-technologies-css',
  // Q46
  profMui: 'how-proficient-are-you-in-the-following-technologies-mui-libraries',
  // Q47
  productBuilding: 'what-product-s-are-you-building',
  // Q48
  muiDevs: 'how-many-developers-are-using-mui-at-your-company',
  // Q49
  companyDevs: 'how-many-developers-work-at-your-company',
  // Q50
  roles: 'which-role-s-best-describe-you',
  // Q51 (open text) — omitted
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
    loadExcelWorkbook(SURVEY_2025_URL, {
      idPrefix: 'survey-2025',
      labelPrefix: '2025 Survey',
      // Fields where cells hold `, `-delimited multi-select answers.
      // The adapter expands these into one row per option when aggregating.
      multiSelectFields: [
        FIELDS.outsource,               // Q02
        FIELDS.advancedComponentsFeedback, // Q11
        FIELDS.schedulerAI,             // Q14
        FIELDS.chartsNextFeatures,      // Q21
        FIELDS.chartsAIFeatures,        // Q24
        FIELDS.ganttAI,                 // Q28
        FIELDS.gridAIUseCases,          // Q32
        FIELDS.aiWorkflow,              // Q39
        FIELDS.productBuilding,         // Q47
        // G-column coded bins for open questions (comma-separated when multi-coded)
        FIELDS.wrapBenefitG,            // Q07 G
        FIELDS.backendServiceFactorsG,  // Q10 G
        FIELDS.schedulerMustHavesG,     // Q12 G
        FIELDS.chartsMigrationFromG,    // Q17 G
        FIELDS.gridUseCaseG,            // Q30 G
        FIELDS.designDevHandoffG,       // Q35 G
        FIELDS.figmaKitImprovementG,    // Q36 G
        FIELDS.aiExperienceG,           // Q37 G
        FIELDS.aiToolsG,                // Q40 G
      ],
      // Collapse "Specific request: <verbatim>" entries into a generic "Other" bucket.
      // The G columns use this prefix to tag unique verbatim responses that didn't
      // fit an existing bin; grouping them all as "Other" keeps charts readable.
      fieldValueTransforms: Object.fromEntries(
        [
          FIELDS.wrapBenefitG,
          FIELDS.backendServiceFactorsG,
          FIELDS.schedulerMustHavesG,
          FIELDS.chartsMigrationFromG,
          FIELDS.gridUseCaseG,
          FIELDS.designDevHandoffG,
          FIELDS.figmaKitImprovementG,
          FIELDS.aiExperienceG,
          FIELDS.aiToolsG,
        ].map((fieldId) => [
          fieldId,
          (v: string) => (v.startsWith('Specific request:') ? 'Other' : v),
        ]),
      ),
    }),
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
