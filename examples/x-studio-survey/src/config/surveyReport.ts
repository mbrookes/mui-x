/**
 * MUI 2025 Developer Survey report — authored as an x-studio dashboard.
 *
 * Structure mirrors the published report at mui-2025-survey-report.vercel.app:
 * - 8 section pages (Styling, MUI X, Scheduler, Charts, Gantt, Data Grid, Figma, AI, About You)
 * - Every question gets a [horizontal bar · Distribution] + [donut · Composition] row
 * - Q41 (email PII) and Q51 (open text) are intentionally omitted
 */
import type { StudioPage, StudioState, StudioWidget } from '@mui/x-studio';
import { FIELDS, SURVEY_2025_SOURCE_ID } from '../surveyData';

const SRC = SURVEY_2025_SOURCE_ID;

function qBar(id: string, title: string, field: string): StudioWidget {
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
      barLayout: 'horizontal',
      chartSortBy: 'value',
      chartSortDirection: 'desc',
    },
  };
}

function qDonut(id: string, title: string, field: string): StudioWidget {
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

/**
 * One entry per survey question:
 * [question number (zero-padded), display label for bar chart, display label for donut, field id]
 *
 * The bar gets "Distribution · Counts" appended; donut gets "Composition · Percentages".
 * Both labels use the question text so the widget title is self-contained.
 */
const QUESTIONS: [string, string, string][] = [
  // ── Styling ────────────────────────────────────────────────────────────────
  ['01', 'How would you prefer your component library to handle styling?', FIELDS.stylingHandling],
  [
    '02',
    'Which parts would you happily outsource to the library/vendor instead of building and maintaining them yourself?',
    FIELDS.outsource,
  ],
  ['03', 'What styling solution do you prefer using?', FIELDS.stylingSolution],
  [
    '04',
    'Rate the statement: "I like having rich defaults and out-of-the-box features, even if customization is limited."',
    FIELDS.richDefaults,
  ],
  ['05', 'Do you wrap Material UI inside your own component library?', FIELDS.wrapMui],
  ['06', 'Which documentation setup does your team primarily use?', FIELDS.docsSetup],
  ['07', 'What\'s the benefit you get from wrapping the library?', FIELDS.wrapBenefit],

  // ── MUI X ─────────────────────────────────────────────────────────────────
  ['08', 'Which MUI X plan are you using?', FIELDS.plan],
  ['09', 'How happy are you winth the commercial components?', FIELDS.commercialHappiness],
  [
    '10',
    'When considering UI components that rely on MUI backend services, like the AI Assistant, what are the factors that influence your decision (if any)?',
    FIELDS.backendServiceFactors,
  ],
  [
    '11',
    'Which advanced components are you interested in giving feedback on?',
    FIELDS.advancedComponentsFeedback,
  ],

  // ── Scheduler ─────────────────────────────────────────────────────────────
  ['12', 'Which Scheduler features are must-haves for you?', FIELDS.schedulerMustHaves],
  [
    '13',
    'How would you like the Scheduler to handle backend and integrations?',
    FIELDS.schedulerBackend,
  ],
  ['14', 'Which AI features would be most useful in the Scheduler?', FIELDS.schedulerAI],

  // ── Charts ─────────────────────────────────────────────────────────────────
  [
    '15',
    'Rank the following criteria by their importance when choosing a charting library.',
    FIELDS.chartingCriteria,
  ],
  ['16', 'Are you using MUI X Charts?', FIELDS.usingCharts],
  [
    '17',
    'Where did you migrate from and what was the decisive factor?',
    FIELDS.chartsMigrationFrom,
  ],
  ['18', "What's stopping you from using MUI X Charts?", FIELDS.chartsBlocker],
  ['19', 'Which charts library do you currently use?', FIELDS.chartsLibrary],
  [
    '20',
    'Which of the following best describes your situation regarding MUI X Charts Pro/Premium?',
    FIELDS.chartsProSituation,
  ],
  ['21', 'Which features do you want us to ship next?', FIELDS.chartsNextFeatures],
  ['22', "What's your typical dataset size?", FIELDS.chartsDatasetSize],
  [
    '23',
    'Which backend-related features would you find useful for Charts?',
    FIELDS.chartsBackendFeatures,
  ],
  ['24', 'Which AI-powered chart features would help you most?', FIELDS.chartsAIFeatures],

  // ── Gantt ──────────────────────────────────────────────────────────────────
  ['25', "What's your primary use for Gantt charts?", FIELDS.ganttPrimaryUse],
  ['26', 'What one feature would most improve your Gantt workflow?', FIELDS.ganttFeature],
  ['27', 'What top challenges do you face with your Gantt solution?', FIELDS.ganttChallenges],
  ['28', 'Which AI features would be most helpful for planning?', FIELDS.ganttAI],

  // ── Data Grid ──────────────────────────────────────────────────────────────
  [
    '29',
    'Rank the following criteria by their importance when choosing a data grid component.',
    FIELDS.gridCriteria,
  ],
  [
    '30',
    "What's your main use case or biggest pain point with Data Grid?",
    FIELDS.gridUseCase,
  ],
  ['31', 'How large are your typical Data Grid datasets?', FIELDS.gridDatasetSize],
  ['32', 'Which AI assistant use cases are you interested in?', FIELDS.gridAIUseCases],

  // ── Figma ──────────────────────────────────────────────────────────────────
  ['33', 'Have you or anyone in your team used the MUI Figma Kit?', FIELDS.figmaKitUsage],
  [
    '34',
    'How well does the Figma Kit match the components you implement in code?',
    FIELDS.figmaKitMatch,
  ],
  [
    '35',
    'What gets in the way during design -> development hands off?',
    FIELDS.designDevHandoff,
  ],
  [
    '36',
    'If we could improve one thing about the MUI Figma Kit, what should it be?',
    FIELDS.figmaKitImprovement,
  ],

  // ── AI ─────────────────────────────────────────────────────────────────────
  [
    '37',
    'Describe the last time you used AI with any MUI project. Did you accomplish your goal, how did it turn out?',
    FIELDS.aiExperience,
  ],
  [
    '38',
    'On a scale from 1 to 10, how would rate how often do you use AI in front-end work?',
    FIELDS.aiUsage,
  ],
  ['39', 'Where does AI fit into your workflow?', FIELDS.aiWorkflow],
  [
    '40',
    'Which tools or services are involved when incorporating AI into your front-end work?',
    FIELDS.aiTools,
  ],

  // ── About You ──────────────────────────────────────────────────────────────
  ['42', 'Where did you first hear about MUI?', FIELDS.heardAbout],
  [
    '43',
    'How proficient are you in the following technologies? [JavaScript]',
    FIELDS.profJs,
  ],
  ['44', 'How proficient are you in the following technologies? [React]', FIELDS.profReact],
  ['45', 'How proficient are you in the following technologies? [CSS]', FIELDS.profCss],
  [
    '46',
    'How proficient are you in the following technologies? [MUI libraries]',
    FIELDS.profMui,
  ],
  ['47', 'What product(s) are you building?', FIELDS.productBuilding],
  ['48', 'How many developers are using MUI at your company?', FIELDS.muiDevs],
  ['49', 'How many developers work at your company?', FIELDS.companyDevs],
  ['50', 'Which role(s) best describe you?', FIELDS.roles],
];

const widgets: Record<string, StudioWidget> = {};
for (const [nn, question, field] of QUESTIONS) {
  widgets[`q${nn}-bar`] = qBar(`q${nn}-bar`, `Q${nn} · ${question}`, field);
  widgets[`q${nn}-donut`] = qDonut(`q${nn}-donut`, `Q${nn} · ${question}`, field);
}

function qRow(nn: string): [string, string] {
  return [`q${nn}-bar`, `q${nn}-donut`];
}

const pages: Record<string, StudioPage> = {
  'page-styling': {
    id: 'page-styling',
    title: 'Styling',
    widgetRows: [
      qRow('01'),
      qRow('02'),
      qRow('03'),
      qRow('04'),
      qRow('05'),
      qRow('06'),
      qRow('07'),
    ],
  },
  'page-muix': {
    id: 'page-muix',
    title: 'MUI X',
    widgetRows: [qRow('08'), qRow('09'), qRow('10'), qRow('11')],
  },
  'page-scheduler': {
    id: 'page-scheduler',
    title: 'Scheduler',
    widgetRows: [qRow('12'), qRow('13'), qRow('14')],
  },
  'page-charts': {
    id: 'page-charts',
    title: 'Charts',
    widgetRows: [
      qRow('15'),
      qRow('16'),
      qRow('17'),
      qRow('18'),
      qRow('19'),
      qRow('20'),
      qRow('21'),
      qRow('22'),
      qRow('23'),
      qRow('24'),
    ],
  },
  'page-gantt': {
    id: 'page-gantt',
    title: 'Gantt',
    widgetRows: [qRow('25'), qRow('26'), qRow('27'), qRow('28')],
  },
  'page-datagrid': {
    id: 'page-datagrid',
    title: 'Data Grid',
    widgetRows: [qRow('29'), qRow('30'), qRow('31'), qRow('32')],
  },
  'page-figma': {
    id: 'page-figma',
    title: 'Figma',
    widgetRows: [qRow('33'), qRow('34'), qRow('35'), qRow('36')],
  },
  'page-ai': {
    id: 'page-ai',
    title: 'AI',
    widgetRows: [qRow('37'), qRow('38'), qRow('39'), qRow('40')],
  },
  'page-about': {
    id: 'page-about',
    title: 'About You',
    widgetRows: [
      qRow('42'),
      qRow('43'),
      qRow('44'),
      qRow('45'),
      qRow('46'),
      qRow('47'),
      qRow('48'),
      qRow('49'),
      qRow('50'),
    ],
  },
};

/** The full survey report dashboard config (data sources are injected at load time). */
export const SURVEY_DASHBOARD: Partial<StudioState> = {
  dashboard: {
    id: 'dashboard-survey-2025',
    title: 'MUI · 2025 Annual Developer Survey',
    activePageId: 'page-styling',
  },
  pages,
  widgets,
};
