/**
 * Curated 2023 → 2025 comparison pairs for the "survey-yoy-comparison" custom widget.
 *
 * Only questions with a defensible category mapping are included here. Two candidate pairs were
 * considered and deliberately left out:
 * - Job-role ("current job role" vs "role(s) best describe you"): 2023 reads as single-select,
 *   2025 as multi-select, so per-category percentages aren't on the same footing.
 * - JS proficiency ("How experienced..." vs "How proficient..."): 2023's four options are
 *   self-deprecating free text ("The job gets done, but sometimes it's a mystery") rather than a
 *   formal skill scale, so mapping them onto 2025's Beginner/Intermediate/Advanced/Expert scale
 *   would be a subjective guess baked into a real report — needs a human call, not an assumption.
 *
 * Field ids: 2025 ids come from `FIELDS` in `../surveyData`. 2023 has no named field-id
 * constants (see `surveyData.ts`), so its ids are the raw column header run through the same
 * `slugify()` used by `connectors/excelAdapter.ts` (lowercase, non-alphanumeric runs -> `-`).
 */
import { FIELDS } from '../surveyData';
import type { YoyFieldPair } from '../shared/yoyComparison';

export const YOY_PAIRS: YoyFieldPair[] = [
  {
    id: 'plan',
    title: 'Which MUI X plan are you on?',
    field2023: 'which-mui-x-plan-are-you-on',
    field2025: FIELDS.plan,
    categoryOrder: ['Community', 'Pro', 'Premium'],
    map2023: {
      'Open-source (community)': 'Community',
      'MUI X Pro': 'Pro',
      'MUI X Premium': 'Premium',
    },
    map2025: {
      'MUI X Community (free)': 'Community',
      'MUI X Pro': 'Pro',
      'MUI X Premium': 'Premium',
      // "We don't use any advanced components" has no 2023 analog (2023 forced a plan choice) —
      // dropped rather than folded into "Other" so it doesn't distort the comparable buckets.
    },
    // 2025-only respondents with no advanced-component usage are excluded from both years'
    // denominators, so this compares plan mix among respondents who use MUI X components.
    dropUnmapped: true,
  },
  {
    id: 'heardAbout',
    title: 'How did you first hear about MUI?',
    field2023: 'how-did-you-first-hear-about-mui',
    field2025: FIELDS.heardAbout,
    categoryOrder: [
      'Already used at my company',
      'Search',
      'Word of mouth',
      'Tutorial',
      'On a blog',
      'Social media',
      'Conference',
      'Other',
    ],
    map2023: {
      'Already used at my company': 'Already used at my company',
      'Organic search': 'Search',
      'Search (e.g. Google search)': 'Search',
      'Word of mouth': 'Word of mouth',
      'Tutorial, e.g., on YouTube': 'Tutorial',
      'Tutorial (e.g. on YouTube)': 'Tutorial',
      'On a blog': 'On a blog',
      'Social media': 'Social media',
      Conference: 'Conference',
      Other: 'Other',
    },
    map2025: {
      'Already used at my company': 'Already used at my company',
      'Organic search (e.g. Google)': 'Search',
      'Word of mouth': 'Word of mouth',
      'Tutorial (e.g. YouTube)': 'Tutorial',
      'On a blog': 'On a blog',
      'Social media (e.g. Reddit)': 'Social media',
      Conference: 'Conference',
      Other: 'Other',
      // "LLMs (e.g. ChatGPT)" has no 2023 analog (didn't exist as a category then) — folds into
      // "Other" along with ~35 one-off free-text answers, via the dropUnmapped:false default.
    },
    caveat:
      '2025 free-text answers and the "LLMs" option (no 2023 equivalent) are folded into "Other".',
  },
  {
    id: 'companyDevs',
    title: 'How many developers work at your company?',
    field2023: 'how-many-developers-work-at-your-place-of-employment',
    field2025: FIELDS.companyDevs,
    categoryOrder: ['Only me', '2–5', '6–10', '11–25', '26–50', '51–200', '201–500', '500+'],
    map2023: {
      'Self-employed': 'Only me',
      // Curly apostrophe is intentional: must byte-match the raw spreadsheet cell value.
      // eslint-disable-next-line mui/straight-quotes
      'It’s a Hobby / Side project': 'Only me',
      '2 - 5': '2–5',
      '6 - 10': '6–10',
      // 2023's 11-20/21-50 split doesn't align to 2025's 11-25/26-50 split — approximated by
      // nearest bucket (see `caveat`); respondents sized 21-25 land in the 2023 side's "26–50".
      '11 - 20': '11–25',
      '21 - 50': '26–50',
      '51 - 200': '51–200',
      '201 - 500': '201–500',
      '501 - 1,000': '500+',
      '1,001 - 3,000': '500+',
      '3,001 - 10,000': '500+',
      '10,000+': '500+',
    },
    map2025: {
      'Only me': 'Only me',
      '2–5': '2–5',
      '6–10': '6–10',
      '11–25': '11–25',
      '26–50': '26–50',
      '51–200': '51–200',
      '201–500': '201–500',
      '500+': '500+',
    },
    caveat:
      '2023 used 11-20/21-50 team-size bins; 2025 uses 11-25/26-50. Approximated by nearest bucket — a handful of 21-25-person teams may land a bucket off.',
  },
];
