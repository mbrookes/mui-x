/**
 * The MUI Developer Survey report, authored as an x-studio dashboard.
 *
 * Every widget reads from the spreadsheet-backed data sources produced by the
 * generic Excel adapter (see `surveyData.ts`). Charts aggregate the raw survey
 * responses with a `count` aggregation — one bar/slice per answer — so the
 * report is driven entirely by the data in the workbooks.
 *
 * Pages mirror the thematic sections of the published 2025 survey report:
 * Overview, Respondents, Skills & Styling, MUI X, and AI.
 */
import type { StudioPage, StudioState, StudioWidget } from '@mui/x-studio';
import { FIELDS, SURVEY_2025_SOURCE_ID } from '../surveyData';

const SRC = SURVEY_2025_SOURCE_ID;

/** A bar chart that counts responses per answer of a single-choice question. */
function countBar(
  id: string,
  title: string,
  field: string,
  opts: { horizontal?: boolean; sortByValue?: boolean } = {},
): StudioWidget {
  return {
    id,
    kind: 'chart',
    title,
    titleMode: 'manual',
    sourceId: SRC,
    config: {
      chartType: 'bar',
      xField: field,
      yField: field,
      yAggregation: 'count',
      ...(opts.horizontal ? { barLayout: 'horizontal' } : {}),
      chartSortBy: opts.sortByValue === false ? 'category' : 'value',
      chartSortDirection: 'desc',
    },
  };
}

/** A donut chart that counts responses per answer of a single-choice question. */
function countDonut(id: string, title: string, field: string): StudioWidget {
  return {
    id,
    kind: 'chart',
    title,
    titleMode: 'manual',
    sourceId: SRC,
    config: {
      chartType: 'donut',
      xField: field,
      yField: field,
      yAggregation: 'count',
      pieArcLabel: 'percent',
    },
  };
}

function kpi(
  id: string,
  title: string,
  field: string,
  aggregation: 'count' | 'avg',
  opts: { suffix?: string } = {},
): StudioWidget {
  return {
    id,
    kind: 'kpi',
    title,
    titleMode: 'manual',
    sourceId: SRC,
    config: {
      kpiValueField: field,
      kpiAggregation: aggregation,
      ...(opts.suffix ? { kpiSuffix: opts.suffix } : {}),
    },
  };
}

function text(id: string, widget: Partial<StudioWidget> & { config: StudioWidget['config'] }): StudioWidget {
  return {
    id,
    kind: 'text',
    title: widget.title ?? '',
    titleMode: 'manual',
    sourceId: undefined,
    config: widget.config,
  };
}

const widgets: Record<string, StudioWidget> = {
  // ── Overview ──────────────────────────────────────────────────────────────
  'w-hero': text('w-hero', {
    title: 'MUI Developer Survey 2025',
    config: {
      textTitleFontSize: 40,
      textTitleAlign: 'center',
      textSubtitle:
        'What 2,057 developers told us about how they build with MUI — their stack, their styling, MUI X, and AI.',
      textSubtitleAlign: 'center',
      textSubtitleFontSize: 18,
      textBody:
        'This report visualizes the raw responses to the 2025 survey, read directly from the source ' +
        'spreadsheet through a custom Excel data adapter. Use edit mode to explore the underlying data.',
      textBodyAlign: 'center',
    },
  }),
  'w-kpi-responses': kpi('w-kpi-responses', 'Total responses', FIELDS.submissionId, 'count'),
  'w-kpi-ai': kpi('w-kpi-ai', 'Avg. AI usage (0–10)', FIELDS.aiUsage, 'avg'),
  'w-kpi-defaults': kpi('w-kpi-defaults', 'Avg. “rich defaults” (1–5)', FIELDS.richDefaults, 'avg'),
  'w-kpi-happiness': kpi(
    'w-kpi-happiness',
    'Avg. commercial happiness (1–5)',
    FIELDS.commercialHappiness,
    'avg',
  ),
  'w-overview-source': countDonut('w-overview-source', 'How respondents reached the survey', FIELDS.source),
  'w-overview-roles': countBar('w-overview-roles', 'Roles', FIELDS.roles, { horizontal: true }),

  // ── Respondents ───────────────────────────────────────────────────────────
  'w-resp-text': text('w-resp-text', {
    title: 'Who responded',
    config: { textTitleFontSize: 28 },
  }),
  'w-resp-heard': countBar('w-resp-heard', 'Where developers first heard about MUI', FIELDS.heardAbout, {
    horizontal: true,
  }),
  'w-resp-roles': countBar('w-resp-roles', 'Roles', FIELDS.roles, { horizontal: true }),
  'w-resp-company': countBar('w-resp-company', 'Developers at the company', FIELDS.companyDevs, {
    sortByValue: false,
  }),
  'w-resp-muidevs': countBar('w-resp-muidevs', 'Developers using MUI at the company', FIELDS.muiDevs, {
    sortByValue: false,
  }),

  // ── Skills & Styling ──────────────────────────────────────────────────────
  'w-skills-text': text('w-skills-text', {
    title: 'Skills & styling',
    config: { textTitleFontSize: 28 },
  }),
  'w-skills-js': countBar('w-skills-js', 'JavaScript proficiency', FIELDS.profJs, {
    horizontal: true,
    sortByValue: false,
  }),
  'w-skills-react': countBar('w-skills-react', 'React proficiency', FIELDS.profReact, {
    horizontal: true,
    sortByValue: false,
  }),
  'w-skills-css': countBar('w-skills-css', 'CSS proficiency', FIELDS.profCss, {
    horizontal: true,
    sortByValue: false,
  }),
  'w-skills-mui': countBar('w-skills-mui', 'MUI libraries proficiency', FIELDS.profMui, {
    horizontal: true,
    sortByValue: false,
  }),
  'w-skills-styling-solution': countBar(
    'w-skills-styling-solution',
    'Preferred styling solution',
    FIELDS.stylingSolution,
    { horizontal: true },
  ),
  'w-skills-styling-handling': countBar(
    'w-skills-styling-handling',
    'Preferred default styling',
    FIELDS.stylingHandling,
    { horizontal: true },
  ),
  'w-skills-wrap': countDonut('w-skills-wrap', 'Wrap Material UI in an in-house library?', FIELDS.wrapMui),
  'w-skills-docs': countBar('w-skills-docs', 'Primary documentation setup', FIELDS.docsSetup, {
    horizontal: true,
  }),

  // ── MUI X ─────────────────────────────────────────────────────────────────
  'w-muix-text': text('w-muix-text', {
    title: 'MUI X',
    config: { textTitleFontSize: 28 },
  }),
  'w-muix-plan': countDonut('w-muix-plan', 'Which MUI X plan are you using?', FIELDS.plan),
  'w-muix-charts': countDonut('w-muix-charts', 'Are you using MUI X Charts?', FIELDS.usingCharts),
  'w-muix-happiness': countBar(
    'w-muix-happiness',
    'Happiness with the commercial components (1–5)',
    FIELDS.commercialHappiness,
    { sortByValue: false },
  ),
  'w-muix-defaults': countBar(
    'w-muix-defaults',
    'I like rich defaults, even if customization is limited (1–5)',
    FIELDS.richDefaults,
    { sortByValue: false },
  ),

  // ── AI ────────────────────────────────────────────────────────────────────
  'w-ai-text': text('w-ai-text', {
    title: 'AI in the front-end workflow',
    config: {
      textTitleFontSize: 28,
      textBody:
        'Respondents rated how often they use AI in front-end work on a scale from 0 (never) to 10 (constantly).',
    },
  }),
  'w-ai-usage': countBar('w-ai-usage', 'How often do you use AI in front-end work? (0–10)', FIELDS.aiUsage, {
    sortByValue: false,
  }),
};

const pages: Record<string, StudioPage> = {
  'page-overview': {
    id: 'page-overview',
    title: 'Overview',
    widgetRows: [
      ['w-hero'],
      ['w-kpi-responses', 'w-kpi-ai', 'w-kpi-defaults', 'w-kpi-happiness'],
      ['w-overview-source', 'w-overview-roles'],
    ],
  },
  'page-respondents': {
    id: 'page-respondents',
    title: 'Respondents',
    widgetRows: [
      ['w-resp-text'],
      ['w-resp-heard', 'w-resp-roles'],
      ['w-resp-company', 'w-resp-muidevs'],
    ],
  },
  'page-skills': {
    id: 'page-skills',
    title: 'Skills & Styling',
    widgetRows: [
      ['w-skills-text'],
      ['w-skills-js', 'w-skills-react'],
      ['w-skills-css', 'w-skills-mui'],
      ['w-skills-styling-solution', 'w-skills-styling-handling'],
      ['w-skills-wrap', 'w-skills-docs'],
    ],
  },
  'page-muix': {
    id: 'page-muix',
    title: 'MUI X',
    widgetRows: [
      ['w-muix-text'],
      ['w-muix-plan', 'w-muix-charts'],
      ['w-muix-happiness', 'w-muix-defaults'],
    ],
  },
  'page-ai': {
    id: 'page-ai',
    title: 'AI',
    widgetRows: [['w-ai-text'], ['w-ai-usage']],
  },
};

/** The full survey report dashboard config (data sources are injected at load time). */
export const SURVEY_DASHBOARD: Partial<StudioState> = {
  dashboard: {
    id: 'dashboard-survey-2025',
    title: 'MUI Developer Survey 2025',
    activePageId: 'page-overview',
  },
  pages,
  widgets,
};
