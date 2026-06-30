/**
 * MUI 2025 Developer Survey report — authored as an x-studio dashboard.
 *
 * Each question gets a full-width text block (title = question text, subtitle = stats)
 * followed by a [Distribution · Counts bar, Composition · Percentages donut] row.
 * Q41 (email PII) and Q51 (open text) are intentionally omitted.
 */
import type { StudioPage, StudioPageTheme, StudioState, StudioWidget } from '@mui/x-studio';
import { FIELDS, SURVEY_2025_SOURCE_ID } from '../surveyData';

const SRC = SURVEY_2025_SOURCE_ID;
const TOTAL_RESPONDENTS = 2057;

type QuestionType = 'Single answer' | 'Multi-select' | 'Open question' | 'Ranking';

interface QuestionMeta {
  n: number;
  question: string;
  field: string;
  plotted: number;
  categories: number;
  type: QuestionType;
}

const QUESTIONS: QuestionMeta[] = [
  // ── Styling ────────────────────────────────────────────────────────────────
  {
    n: 1,
    question: 'How would you prefer your component library to handle styling?',
    field: FIELDS.stylingHandling,
    plotted: 1549,
    categories: 15,
    type: 'Single answer',
  },
  {
    n: 2,
    question:
      'Which parts would you happily outsource to the library/vendor instead of building and maintaining them yourself?',
    field: FIELDS.outsource,
    plotted: 3664,
    categories: 13,
    type: 'Multi-select',
  },
  {
    n: 3,
    question: 'What styling solution do you prefer using?',
    field: FIELDS.stylingSolution,
    plotted: 1331,
    categories: 15,
    type: 'Single answer',
  },
  {
    n: 4,
    question:
      'Rate the statement: "I like having rich defaults and out-of-the-box features, even if customization is limited."',
    field: FIELDS.richDefaults,
    plotted: 1133,
    categories: 5,
    type: 'Single answer',
  },
  {
    n: 5,
    question: 'Do you wrap Material UI inside your own component library?',
    field: FIELDS.wrapMui,
    plotted: 1080,
    categories: 2,
    type: 'Single answer',
  },
  {
    n: 6,
    question: 'Which documentation setup does your team primarily use?',
    field: FIELDS.docsSetup,
    plotted: 525,
    categories: 15,
    type: 'Single answer',
  },
  {
    n: 7,
    question: "What's the benefit you get from wrapping the library?",
    field: FIELDS.wrapBenefitG,
    plotted: 199,
    categories: 15,
    type: 'Open question',
  },

  // ── MUI X ─────────────────────────────────────────────────────────────────
  {
    n: 8,
    question: 'Which MUI X plan are you using?',
    field: FIELDS.plan,
    plotted: 1091,
    categories: 4,
    type: 'Single answer',
  },
  {
    n: 9,
    question: 'How happy are you winth the commercial components?',
    field: FIELDS.commercialHappiness,
    plotted: 289,
    categories: 5,
    type: 'Single answer',
  },
  {
    n: 10,
    question:
      'When considering UI components that rely on MUI backend services, like the AI Assistant, what are the factors that influence your decision (if any)?',
    field: FIELDS.backendServiceFactorsG,
    plotted: 123,
    categories: 15,
    type: 'Open question',
  },
  {
    n: 11,
    question: 'Which advanced components are you interested in giving feedback on?',
    field: FIELDS.advancedComponentsFeedback,
    plotted: 987,
    categories: 5,
    type: 'Multi-select',
  },

  // ── Scheduler ─────────────────────────────────────────────────────────────
  {
    n: 12,
    question: 'Which Scheduler features are must-haves for you?',
    field: FIELDS.schedulerMustHavesG,
    plotted: 65,
    categories: 10,
    type: 'Open question',
  },
  {
    n: 13,
    question: 'How would you like the Scheduler to handle backend and integrations?',
    field: FIELDS.schedulerBackend,
    plotted: 58,
    categories: 5,
    type: 'Single answer',
  },
  {
    n: 14,
    question: 'Which AI features would be most useful in the Scheduler?',
    field: FIELDS.schedulerAI,
    plotted: 131,
    categories: 6,
    type: 'Multi-select',
  },

  // ── Charts ─────────────────────────────────────────────────────────────────
  {
    n: 15,
    question: 'Rank the following criteria by their importance when choosing a charting library.',
    field: FIELDS.chartingCriteria,
    plotted: 131,
    categories: 11,
    type: 'Ranking',
  },
  {
    n: 16,
    question: 'Are you using MUI X Charts?',
    field: FIELDS.usingCharts,
    plotted: 122,
    categories: 3,
    type: 'Single answer',
  },
  {
    n: 17,
    question: 'Where did you migrate from and what was the decisive factor?',
    field: FIELDS.chartsMigrationFromG,
    plotted: 11,
    categories: 8,
    type: 'Open question',
  },
  {
    n: 18,
    question: "What's stopping you from using MUI X Charts?",
    field: FIELDS.chartsBlocker,
    plotted: 51,
    categories: 7,
    type: 'Single answer',
  },
  {
    n: 19,
    question: 'Which charts library do you currently use?',
    field: FIELDS.chartsLibrary,
    plotted: 37,
    categories: 15,
    type: 'Single answer',
  },
  {
    n: 20,
    question:
      'Which of the following best describes your situation regarding MUI X Charts Pro/Premium?',
    field: FIELDS.chartsProSituation,
    plotted: 59,
    categories: 6,
    type: 'Single answer',
  },
  {
    n: 21,
    question: 'Which features do you want us to ship next?',
    field: FIELDS.chartsNextFeatures,
    plotted: 282,
    categories: 14,
    type: 'Multi-select',
  },
  {
    n: 22,
    question: "What's your typical dataset size?",
    field: FIELDS.chartsDatasetSize,
    plotted: 77,
    categories: 5,
    type: 'Single answer',
  },
  {
    n: 23,
    question: 'Which backend-related features would you find useful for Charts?',
    field: FIELDS.chartsBackendFeatures,
    plotted: 52,
    categories: 5,
    type: 'Single answer',
  },
  {
    n: 24,
    question: 'Which AI-powered chart features would help you most?',
    field: FIELDS.chartsAIFeatures,
    plotted: 60,
    categories: 4,
    type: 'Multi-select',
  },

  // ── Gantt ──────────────────────────────────────────────────────────────────
  {
    n: 25,
    question: "What's your primary use for Gantt charts?",
    field: FIELDS.ganttPrimaryUse,
    plotted: 42,
    categories: 5,
    type: 'Single answer',
  },
  {
    n: 26,
    question: 'What one feature would most improve your Gantt workflow?',
    field: FIELDS.ganttFeature,
    plotted: 10,
    categories: 10,
    type: 'Single answer',
  },
  {
    n: 27,
    question: 'What top challenges do you face with your Gantt solution?',
    field: FIELDS.ganttChallenges,
    plotted: 8,
    categories: 8,
    type: 'Single answer',
  },
  {
    n: 28,
    question: 'Which AI features would be most helpful for planning?',
    field: FIELDS.ganttAI,
    plotted: 92,
    categories: 9,
    type: 'Multi-select',
  },

  // ── Data Grid ──────────────────────────────────────────────────────────────
  {
    n: 29,
    question:
      'Rank the following criteria by their importance when choosing a data grid component.',
    field: FIELDS.gridCriteria,
    plotted: 275,
    categories: 13,
    type: 'Ranking',
  },
  {
    n: 30,
    question: "What's your main use case or biggest pain point with Data Grid?",
    field: FIELDS.gridUseCaseG,
    plotted: 101,
    categories: 15,
    type: 'Open question',
  },
  {
    n: 31,
    question: 'How large are your typical Data Grid datasets?',
    field: FIELDS.gridDatasetSize,
    plotted: 242,
    categories: 4,
    type: 'Single answer',
  },
  {
    n: 32,
    question: 'Which AI assistant use cases are you interested in?',
    field: FIELDS.gridAIUseCases,
    plotted: 362,
    categories: 7,
    type: 'Multi-select',
  },

  // ── Figma ──────────────────────────────────────────────────────────────────
  {
    n: 33,
    question: 'Have you or anyone in your team used the MUI Figma Kit?',
    field: FIELDS.figmaKitUsage,
    plotted: 782,
    categories: 5,
    type: 'Single answer',
  },
  {
    n: 34,
    question: 'How well does the Figma Kit match the components you implement in code?',
    field: FIELDS.figmaKitMatch,
    plotted: 194,
    categories: 10,
    type: 'Single answer',
  },
  {
    n: 35,
    question: 'What gets in the way during design -> development hands off?',
    field: FIELDS.designDevHandoffG,
    plotted: 40,
    categories: 15,
    type: 'Open question',
  },
  {
    n: 36,
    question: 'If we could improve one thing about the MUI Figma Kit, what should it be?',
    field: FIELDS.figmaKitImprovementG,
    plotted: 33,
    categories: 15,
    type: 'Open question',
  },

  // ── AI ─────────────────────────────────────────────────────────────────────
  {
    n: 37,
    question:
      'Describe the last time you used AI with any MUI project. Did you accomplish your goal, how did it turn out?',
    field: FIELDS.aiExperienceG,
    plotted: 199,
    categories: 15,
    type: 'Open question',
  },
  {
    n: 38,
    question: 'On a scale from 1 to 10, how would rate how often do you use AI in front-end work?',
    field: FIELDS.aiUsage,
    plotted: 614,
    categories: 11,
    type: 'Single answer',
  },
  {
    n: 39,
    question: 'Where does AI fit into your workflow?',
    field: FIELDS.aiWorkflow,
    plotted: 2044,
    categories: 10,
    type: 'Multi-select',
  },
  {
    n: 40,
    question:
      'Which tools or services are involved when incorporating AI into your front-end work?',
    field: FIELDS.aiToolsG,
    plotted: 183,
    categories: 15,
    type: 'Open question',
  },

  // ── About You ──────────────────────────────────────────────────────────────
  {
    n: 42,
    question: 'Where did you first hear about MUI?',
    field: FIELDS.heardAbout,
    plotted: 602,
    categories: 15,
    type: 'Single answer',
  },
  {
    n: 43,
    question: 'How proficient are you in the following technologies? [JavaScript]',
    field: FIELDS.profJs,
    plotted: 650,
    categories: 4,
    type: 'Single answer',
  },
  {
    n: 44,
    question: 'How proficient are you in the following technologies? [React]',
    field: FIELDS.profReact,
    plotted: 654,
    categories: 4,
    type: 'Single answer',
  },
  {
    n: 45,
    question: 'How proficient are you in the following technologies? [CSS]',
    field: FIELDS.profCss,
    plotted: 643,
    categories: 4,
    type: 'Single answer',
  },
  {
    n: 46,
    question: 'How proficient are you in the following technologies? [MUI libraries]',
    field: FIELDS.profMui,
    plotted: 641,
    categories: 4,
    type: 'Single answer',
  },
  {
    n: 47,
    question: 'What product(s) are you building?',
    field: FIELDS.productBuilding,
    plotted: 1581,
    categories: 9,
    type: 'Multi-select',
  },
  {
    n: 48,
    question: 'How many developers are using MUI at your company?',
    field: FIELDS.muiDevs,
    plotted: 632,
    categories: 8,
    type: 'Single answer',
  },
  {
    n: 49,
    question: 'How many developers work at your company?',
    field: FIELDS.companyDevs,
    plotted: 632,
    categories: 8,
    type: 'Single answer',
  },
  {
    n: 50,
    question: 'Which role(s) best describe you?',
    field: FIELDS.roles,
    plotted: 684,
    categories: 15,
    type: 'Single answer',
  },
];

function qId(n: number): string {
  return `q${String(n).padStart(2, '0')}`;
}

function qTextWidget(meta: QuestionMeta): StudioWidget {
  return {
    id: `${qId(meta.n)}-text`,
    kind: 'text',
    title: `${meta.n}. ${meta.question}`,
    titleMode: 'manual',
    config: {
      textSubtitle: `${meta.plotted} plotted answers · ${TOTAL_RESPONDENTS} respondents · ${meta.categories} categories`,
      textTitleFontFamily: 'Fraunces, "Inter Tight", serif',
      textTitleFontSize: 24,
      textSubtitleFontFamily: 'sans-serif',
      textSubtitleFontSize: 14,
    },
  };
}

function qBarWidget(meta: QuestionMeta): StudioWidget {
  return {
    id: `${qId(meta.n)}-bar`,
    kind: 'chart',
    title: 'Distribution · Counts',
    titleMode: 'manual',
    subtitle: meta.type,
    subtitleMode: 'manual',
    sourceId: SRC,
    config: {
      titleFontSize: 11,
      cardExpandTitle: `${meta.n}. ${meta.question}`,
      chartType: 'bar',
      xField: meta.field,
      yField: meta.field,
      yAggregation: 'count',
      barLayout: 'horizontal',
      chartSortBy: 'value',
      chartSortDirection: 'desc',
      barBandLabelWrap: 28,
      barMinBandSize: 44,
      barCategoryGapRatio: 0.5,
      barMaxCategories: 10,
    },
  };
}

function qDonutWidget(meta: QuestionMeta): StudioWidget {
  return {
    id: `${qId(meta.n)}-donut`,
    kind: 'chart',
    title: 'Composition · Percentages',
    titleMode: 'manual',
    subtitle: meta.type,
    subtitleMode: 'manual',
    sourceId: SRC,
    config: {
      titleFontSize: 11,
      cardExpandTitle: `${meta.n}. ${meta.question}`,
      chartType: 'donut',
      xField: meta.field,
      yField: meta.field,
      yAggregation: 'count',
      pieArcLabel: 'percent',
      pieMaxSlices: 8,
      pieLegendBelow: true,
    },
  };
}

/** Shared page theme: flat canvas. Track the theme's default background (rgb(250, 250, 246)
 * in light mode) via the CSS variable so dark mode still adapts automatically. */
const PAGE_THEME: StudioPageTheme = {
  cardBorder: false,
  pageBackground: 'var(--mui-palette-background-default)',
};

function qDividerWidget(n: number): StudioWidget {
  return {
    id: `${qId(n)}-divider`,
    kind: 'survey-divider',
    title: '',
    config: {},
  };
}

const widgets: Record<string, StudioWidget> = {};
for (const meta of QUESTIONS) {
  const id = qId(meta.n);
  widgets[`${id}-text`] = qTextWidget(meta);
  widgets[`${id}-bar`] = qBarWidget(meta);
  widgets[`${id}-donut`] = qDonutWidget(meta);
  widgets[`${id}-divider`] = qDividerWidget(meta.n);
}

/** Returns [text-row, chart-row] for a question number. */
function qRows(n: number): string[][] {
  const id = qId(n);
  return [[`${id}-text`], [`${id}-bar`, `${id}-donut`]];
}

/** Returns a single-widget divider row placed BEFORE question n. */
function qDividerRow(n: number): string[][] {
  return [[`${qId(n)}-divider`]];
}

/** Interleaves divider rows between a list of question numbers. */
function withDividers(...ns: number[]): string[][] {
  return ns.flatMap((n, i) => (i === 0 ? qRows(n) : [...qDividerRow(n), ...qRows(n)]));
}

const pages: Record<string, StudioPage> = {
  'page-styling': {
    id: 'page-styling',
    title: 'Styling',
    theme: PAGE_THEME,
    widgetRows: withDividers(1, 2, 3, 4, 5, 6, 7),
  },
  'page-muix': {
    id: 'page-muix',
    title: 'MUI X',
    theme: PAGE_THEME,
    widgetRows: withDividers(8, 9, 10, 11),
  },
  'page-scheduler': {
    id: 'page-scheduler',
    title: 'Scheduler',
    theme: PAGE_THEME,
    widgetRows: withDividers(12, 13, 14),
  },
  'page-charts': {
    id: 'page-charts',
    title: 'Charts',
    theme: PAGE_THEME,
    widgetRows: withDividers(15, 16, 17, 18, 19, 20, 21, 22, 23, 24),
  },
  'page-gantt': {
    id: 'page-gantt',
    title: 'Gantt',
    theme: PAGE_THEME,
    widgetRows: withDividers(25, 26, 27, 28),
  },
  'page-datagrid': {
    id: 'page-datagrid',
    title: 'Data Grid',
    theme: PAGE_THEME,
    widgetRows: withDividers(29, 30, 31, 32),
  },
  'page-figma': {
    id: 'page-figma',
    title: 'Figma',
    theme: PAGE_THEME,
    widgetRows: withDividers(33, 34, 35, 36),
  },
  'page-ai': {
    id: 'page-ai',
    title: 'AI',
    theme: PAGE_THEME,
    widgetRows: withDividers(37, 38, 39, 40),
  },
  'page-about': {
    id: 'page-about',
    title: 'About You',
    theme: PAGE_THEME,
    widgetRows: withDividers(42, 43, 44, 45, 46, 47, 48, 49, 50),
  },
};

/** The full survey report dashboard config (data sources are injected at load time). */
export const SURVEY_DASHBOARD: Partial<StudioState> = {
  mode: 'view',
  dashboard: {
    id: 'dashboard-survey-2025',
    title: 'MUI · 2025 Annual Developer Survey',
    activePageId: 'page-styling',
  },
  pages,
  widgets,
};
