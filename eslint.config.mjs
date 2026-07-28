import {
  baseSpecRules,
  createBaseConfig,
  createDocsConfig,
  createTestConfig,
  EXTENSION_TEST_FILE,
  EXTENSION_TS,
} from '@mui/internal-code-infra/eslint';
import { fixupPluginRules } from '@eslint/compat';
import eslintPluginConsistentNameRaw from 'eslint-plugin-consistent-default-export-name';
import eslintPluginJsdoc from 'eslint-plugin-jsdoc';
import eslintPluginMuiX from 'eslint-plugin-mui-x';
import { defineConfig } from 'eslint/config';
import * as path from 'node:path';
import * as url from 'node:url';
import remarkConfig from './.remarkrc.mjs';

const eslintPluginConsistentName = fixupPluginRules(eslintPluginConsistentNameRaw);

const filename = url.fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const CHARTS_PACKAGES = ['x-charts', 'x-charts-pro', 'x-charts-premium'];
const GRID_PACKAGES = [
  'x-data-grid',
  'x-data-grid-pro',
  'x-data-grid-premium',
  'x-data-grid-generator',
];
const PICKERS_PACKAGES = ['x-date-pickers', 'x-date-pickers-pro'];
const TREE_VIEW_PACKAGES = ['x-tree-view', 'x-tree-view-pro'];
const SCHEDULER_PACKAGES = [
  'x-scheduler',
  'x-scheduler-internals',
  'x-scheduler-premium',
  'x-scheduler-internals-premium',
];

// Enable React Compiler Plugin rules globally
const ENABLE_REACT_COMPILER_PLUGIN = process.env.ENABLE_REACT_COMPILER_PLUGIN ?? false;

// Enable React Compiler Plugin rules per package
const ENABLE_REACT_COMPILER_PLUGIN_CHARTS = process.env.ENABLE_REACT_COMPILER_PLUGIN_CHARTS ?? true;
const ENABLE_REACT_COMPILER_PLUGIN_DATA_GRID =
  process.env.ENABLE_REACT_COMPILER_PLUGIN_DATA_GRID ?? false;
const ENABLE_REACT_COMPILER_PLUGIN_DATE_PICKERS =
  process.env.ENABLE_REACT_COMPILER_PLUGIN_DATE_PICKERS ?? false;
const ENABLE_REACT_COMPILER_PLUGIN_TREE_VIEW =
  process.env.ENABLE_REACT_COMPILER_PLUGIN_TREE_VIEW ?? true;
const ENABLE_REACT_COMPILER_PLUGIN_SCHEDULER =
  process.env.ENABLE_REACT_COMPILER_PLUGIN_SCHEDULER ?? true;

const isAnyReactCompilerPluginEnabled =
  ENABLE_REACT_COMPILER_PLUGIN ||
  ENABLE_REACT_COMPILER_PLUGIN_CHARTS ||
  ENABLE_REACT_COMPILER_PLUGIN_DATA_GRID ||
  ENABLE_REACT_COMPILER_PLUGIN_DATE_PICKERS ||
  ENABLE_REACT_COMPILER_PLUGIN_TREE_VIEW ||
  ENABLE_REACT_COMPILER_PLUGIN_SCHEDULER;

/**
 * @param {Object[]} packageInfo
 * @param {string[]} packageInfo.packagesNames
 * @param {boolean} packageInfo.isEnabled
 */
function getReactCompilerFilesForPackages(packageInfo) {
  return packageInfo
    .filter((pkg) => pkg.isEnabled)
    .flatMap((pkg) =>
      pkg.packagesNames.map((packageName) => `packages/${packageName}/src/**/*${EXTENSION_TS}`),
    );
}

const RESTRICTED_TOP_LEVEL_IMPORTS = [
  '@mui/material',
  '@mui/utils',
  '@mui/x-charts',
  '@mui/x-charts-pro',
  '@mui/x-charts-premium',
  '@mui/x-codemod',
  '@mui/x-date-pickers',
  '@mui/x-date-pickers-pro',
  '@mui/x-tree-view',
  '@mui/x-tree-view-pro',
  '@mui/x-scheduler',
  '@mui/x-scheduler-premium',
  '@mui/x-scheduler-internals',
  '@mui/x-scheduler-internals-premium',
];

const packageFilesWithReactCompiler = getReactCompilerFilesForPackages([
  {
    packagesNames: CHARTS_PACKAGES,
    isEnabled: ENABLE_REACT_COMPILER_PLUGIN_CHARTS,
  },
  {
    packagesNames: GRID_PACKAGES,
    isEnabled: ENABLE_REACT_COMPILER_PLUGIN_DATA_GRID,
  },
  {
    packagesNames: PICKERS_PACKAGES,
    isEnabled: ENABLE_REACT_COMPILER_PLUGIN_DATE_PICKERS,
  },
  {
    packagesNames: TREE_VIEW_PACKAGES,
    isEnabled: ENABLE_REACT_COMPILER_PLUGIN_TREE_VIEW,
  },
  {
    packagesNames: SCHEDULER_PACKAGES,
    isEnabled: ENABLE_REACT_COMPILER_PLUGIN_SCHEDULER,
  },
]);

const baseConfig = createBaseConfig({
  baseDirectory: dirname,
  enableReactCompiler: isAnyReactCompilerPluginEnabled,
  materialUi: true,
  markdown: true,
});

/**
 * The `no-restricted-syntax` restrictions the shared base config installs for every
 * file (namespace-only React imports, `new Error`, `window.setTimeout`, …).
 *
 * Flat config REPLACES a rule's options rather than merging them, so any scoped block
 * that adds one more restriction has to re-state these or it silently switches the
 * shared ones off for the files it covers. Reading them back off the base config keeps
 * that automatic instead of a copy that rots.
 *
 * @type {unknown[]}
 */
const BASE_RESTRICTED_SYNTAX = (Array.isArray(baseConfig) ? baseConfig : [baseConfig])
  .flatMap((entry) => entry?.rules?.['no-restricted-syntax'] ?? [])
  // Drop the leading severity — the scoped block supplies its own.
  .filter((option) => typeof option === 'object' && option !== null);

/**
 * Message for the `sanitizeForPrompt` restriction below. Follows the repo's
 * error-message guidance: what happened, why it is a problem, how to fix it.
 */
const SANITIZE_FOR_PROMPT_MESSAGE =
  '`sanitizeForPrompt` escapes `<` and `>` only, so line breaks and `"` survive it. ' +
  'Every value it guards is state-derived and attacker-influenceable, so on a single ' +
  'line of the system prompt it can forge a `## Security Rules` heading inside the ' +
  'trusted `<dashboard_state>` block, or a sibling `source: "…"` field the widget never ' +
  'reads — a prompt injection that has shipped three times already. Use the `promptLine` ' +
  'tagged template (or `sanitizeForPromptLine`) instead. If this position really is a ' +
  'multi-line, host-authored region where collapsing newlines would corrupt legitimate ' +
  'prose, add an `// eslint-disable-next-line no-restricted-syntax` with a one-line ' +
  'justification so the exception is reviewable.';

/**
 * Message for the `String` restriction on the ai-middleware's sanitizer surface.
 */
const AI_MIDDLEWARE_STRING_MESSAGE =
  'The `String` global is NOT total over `JSON.parse` output: `String({"toString": 1})` ' +
  'throws `TypeError: Cannot convert object to primitive value`, and so does any ' +
  'null-prototype object. Every value on this surface is un-narrowed request-body or ' +
  'tool-argument JSON, so the throw is reachable from a two-token payload — it has ' +
  'already reached `buildApprovalDisplayInput` outside the dispatch try/catch and closed ' +
  'a live SSE stream. Use `asString` from `internal/promptCaps` (or `capText`, which ' +
  'wraps it). If the argument is provably a primitive already, add an ' +
  '`// eslint-disable-next-line no-restricted-syntax` with a one-line justification so ' +
  'the exception is reviewable.';

/**
 * The `no-restricted-syntax` restrictions shared by EVERY file in
 * `x-studio-ai-middleware`. See {@link BASE_RESTRICTED_SYNTAX} for why the base
 * restrictions have to be spread back in.
 *
 * @type {unknown[]}
 */
const AI_MIDDLEWARE_RESTRICTED_SYNTAX = [
  ...BASE_RESTRICTED_SYNTAX,
  {
    selector:
      'Identifier[name="sanitizeForPrompt"]:not(FunctionDeclaration > Identifier.id, ExportSpecifier > Identifier, ImportSpecifier > Identifier)',
    message: SANITIZE_FOR_PROMPT_MESSAGE,
  },
  {
    selector: 'ImportSpecifier > Identifier.imported[name="sanitizeForPrompt"]',
    message: SANITIZE_FOR_PROMPT_MESSAGE,
  },
];

/**
 * Message for the `withTimeout` interpolated-label restriction.
 */
const WITH_TIMEOUT_LABEL_MESSAGE =
  'A `withTimeout` label lands inside a BRANDED `StudioTimeoutError`, and ' +
  '`redactedHostErrorMessage` relays branded messages VERBATIM on the premise that they ' +
  'hold only server-authored prose. Interpolating an untrusted identifier (a `tableName` ' +
  'off `runtime.dataSources`, a client-declared skill name) therefore defeats the brand — ' +
  'two call sites already did. Tag the template with `opLabel` from `mcp/helpers` instead: ' +
  'it sanitizes every interpolation hole while keeping the literal prose intact. If every ' +
  'interpolation is provably server-authored, add an ' +
  '`// eslint-disable-next-line no-restricted-syntax` with a one-line justification so the ' +
  'exception is reviewable.';

/**
 * The sanitizer / totality / prompt-construction surface of `x-studio-ai-middleware`:
 * the modules that coerce untrusted `JSON.parse` output to a string on the way into a
 * prompt, an SVG, an error message, or an approval payload.
 *
 * Scoped to these files rather than the whole package because the remaining `String(…)`
 * call sites there are error-formatting fallbacks in request/response plumbing
 * (`handleAIChat.ts`, `handleGenerateInsight.ts`, `mcp.ts`, `internal/providerError.ts`)
 * that are the same hazard class but were out of scope for the change that added this
 * rule. Widening the `files` list is the intended way to finish the sweep — each addition
 * should come with the `asString` conversions that file needs.
 */
const AI_MIDDLEWARE_SANITIZER_FILES = [
  'packages/x-studio-ai-middleware/src/buildAISystemPrompt.ts',
  'packages/x-studio-ai-middleware/src/chartRenderer.ts',
  'packages/x-studio-ai-middleware/src/executeToolOnState.ts',
  'packages/x-studio-ai-middleware/src/generateFieldDescriptions.ts',
  'packages/x-studio-ai-middleware/src/agenticLoop/toolDispatch.ts',
  'packages/x-studio-ai-middleware/src/internal/promptCaps.ts',
  'packages/x-studio-ai-middleware/src/mcp/helpers.ts',
  'packages/x-studio-ai-middleware/src/mcp/summarisePage.ts',
  // `query_data_source`'s chart-data builder labels each slice with a row value read
  // straight out of the host's database. A JSON/JSONB column deserializes to an arbitrary
  // object, so the raw `String()` global is a live throw here, not a latent one.
  'packages/x-studio-ai-middleware/src/mcp/queryTools.ts',
  // Two of the `withTimeout` labels here interpolate a client-supplied `tableName` into
  // a BRANDED (relayed-verbatim) timeout message. Both call `safeIdentifier` today, but
  // "remember to sanitize" is exactly the contract two sibling call sites already broke,
  // so the rule — not the reviewer — holds them to `opLabel`.
  'packages/x-studio-ai-middleware/src/mcp/resources.ts',
];

export default defineConfig(
  baseConfig,
  // eslint-plugin-mdx loads `.remarkrc.mjs` itself, but ESLint doesn't know
  // that file is a config dependency, so `--cache` doesn't invalidate when
  // it changes. Embedding the imported value in a setting puts its content
  // into the resolved-config hash, forcing cache invalidation on edits.
  { settings: { remarkConfig } },
  {
    name: 'MUI X Overrides',
    files: [`**/*${EXTENSION_TS}`],
    plugins: {
      jsdoc: eslintPluginJsdoc,
      'mui-x': eslintPluginMuiX,
      'consistent-default-export-name': eslintPluginConsistentName,
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: ['tsconfig.json'],
        },
      },
    },
    rules: {
      '@typescript-eslint/no-redeclare': 'error',
      'mui/straight-quotes': 'error',
      // turn off global react compiler plugin as it's controlled per package on this repo
      'react-compiler/react-compiler': 'off',
      'react/react-in-jsx-scope': 'off',

      // TODO: re-enable. Temporarily disabled after the eslint-plugin-react-hooks
      // 7.1 bump (via @mui/internal-code-infra) introduced this rule, which flags
      // existing code that needs to be addressed separately.
      'react-hooks/set-state-in-effect': 'off',

      // Modern browsers imply rel="noopener" for target="_blank", so no rel is required.
      // See https://github.com/mui/material-ui/pull/40447
      // TODO move to mui/mui-public.
      'react/jsx-no-target-blank': 'off',

      'import/no-relative-packages': 'error',
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            ...CHARTS_PACKAGES,
            ...PICKERS_PACKAGES,
            ...TREE_VIEW_PACKAGES,
            ...SCHEDULER_PACKAGES,
          ].map((packageName) => ({
            target: `./packages/${packageName}/src/**/!(*.test.*|*.spec.*)`,
            from: `./packages/${packageName}/src/internals/index.ts`,
            message: `Use a more specific import instead. E.g. import { MyInternal } from '../internals/MyInternal';`,
          })),
        },
      ],
      'no-restricted-imports': 'off',
      // TODO move to @mui/internal-code-infra/eslint
      'jsdoc/require-param': ['error', { contexts: ['TSFunctionType'] }],
      'jsdoc/require-param-type': ['error', { contexts: ['TSFunctionType'] }],
      'jsdoc/require-param-name': ['error', { contexts: ['TSFunctionType'] }],
      'jsdoc/require-param-description': ['error', { contexts: ['TSFunctionType'] }],
      'jsdoc/require-returns': ['error', { contexts: ['TSFunctionType'] }],
      'jsdoc/require-returns-type': ['error', { contexts: ['TSFunctionType'] }],
      'jsdoc/require-returns-description': ['error', { contexts: ['TSFunctionType'] }],
      'jsdoc/no-bad-blocks': [
        'error',
        {
          ignore: [
            'ts-check',
            'ts-expect-error',
            'ts-ignore',
            'ts-nocheck',
            'typescript-to-proptypes-ignore',
          ],
        },
      ],
      // Fixes false positive when using both `inputProps` and `InputProps` on the same example
      // See https://stackoverflow.com/questions/42367236/why-am-i-getting-this-warning-no-duplicate-props-allowed-react-jsx-no-duplicate
      // TODO move to @mui/internal-code-infra/eslint
      // TODO Fix <Input> props names to not conflict
      'react/jsx-no-duplicate-props': ['warn', { ignoreCase: false }],
      // TODO move to @mui/internal-code-infra/eslint, these are false positive
      'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
      // migration rules
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'react-hooks/exhaustive-deps': [
        'error',
        {
          additionalHooks: '(useEnhancedEffect|useIsoLayoutEffect|useEffectAfterFirstRender)',
        },
      ],
      'react-hooks/immutability': 'off',
      'react-hooks/globals': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/static-components': 'off',

      'mui/no-presentation-role': 'error',

      // TODO(@Janpot) Fix issues and turn back on
      'mui/consistent-production-guard': 'off',
    },
  },
  // Test start
  {
    files: [
      // matching the pattern of the test runner
      `**/*${EXTENSION_TEST_FILE}`,
    ],
    extends: createTestConfig({ useMocha: false, useVitest: true }),
    ignores: ['test/e2e/**/*', 'test/regressions/**/*'],
    rules: {
      // Doesn't work reliantly with chai style .to.deep.equal (replace with .toEqual?)
      'vitest/valid-expect': 'off',
      // Annoying auto-fix
      'vitest/no-focused-tests': 'off',
    },
  },
  {
    files: [
      // TODO: Fix one-by-one
      `packages/x-data-grid{,-*}/**/*${EXTENSION_TEST_FILE}`,
      `packages/x-date-pickers{,-*}/**/*${EXTENSION_TEST_FILE}`,
      `packages/x-internals{,-*}/**/*${EXTENSION_TEST_FILE}`,
      `packages/x-scheduler{,-*}/**/*${EXTENSION_TEST_FILE}`,
    ],
    rules: {
      // Can't unambiguously detect all patterns of adding expects
      'vitest/expect-expect': 'off',
      'vitest/no-standalone-expect': 'off',
    },
  },
  baseSpecRules,
  {
    files: [`packages/x-charts{,-*}/**/*${EXTENSION_TS}`],
    rules: {
      'import/no-cycle': 'error',
      // Charts have no semantics, so we often need to query by container
      'testing-library/no-container': 'off',
    },
  },
  {
    files: [
      `packages/x-charts{,-*}/**/*${EXTENSION_TS}`,
      `packages/x-data-grid{,-*}/**/*${EXTENSION_TS}`,
      `packages/x-date-pickers{,-*}/**/*${EXTENSION_TS}`,
    ],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          fixStyle: 'separate-type-imports',
        },
      ],
      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
    },
  },
  {
    files: [`**/*${EXTENSION_TEST_FILE}`, `test/**/*${EXTENSION_TS}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@testing-library/react', 'test/utils/index'],
        },
      ],
      'compat/compat': 'off',
    },
  },

  {
    files: [
      'packages/x-data-grid/**/*{.tsx,.ts,.js}',
      'packages/x-data-grid-pro/**/*{.tsx,.ts,.js}',
      'packages/x-data-grid-premium/**/*{.tsx,.ts,.js}',
      'docs/src/pages/**/*.tsx',
    ],
    rules: {
      'mui-x/no-direct-state-access': 'error',
    },
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: dirname,
        projectService: true,
      },
    },
  },

  // TODO remove, shouldn't disable prop-type generation rule.
  // lot of public components are missing it.
  {
    files: ['**/*.tsx'],
    ignores: ['**/*.spec.tsx'],
    rules: {
      'react/prop-types': 'off',
    },
  },

  {
    files: [`packages/*/src/**/*${EXTENSION_TS}`],
    ignores: ['**/*.d.ts', `**/*.spec${EXTENSION_TS}`, `**/*.test${EXTENSION_TS}`],
    rules: {
      'mui/material-ui-name-matches-component-name': [
        'error',
        {
          customHooks: [
            'useDatePickerProcessedProps',
            'useDatePickerDefaultizedProps',
            'useTimePickerDefaultizedProps',
            'useDateTimePickerDefaultizedProps',
            'useDateRangePickerDefaultizedProps',
            'useDateTimeRangePickerDefaultizedProps',
            'useTimeRangePickerDefaultizedProps',
            'useDateCalendarDefaultizedProps',
            'useMonthCalendarDefaultizedProps',
            'useYearCalendarDefaultizedProps',
            'useDateRangeCalendarDefaultizedProps',
          ],
        },
      ],
      'mui/disallow-react-api-in-server-components': 'error',
    },
  },

  // Catch leaked subscriptions: call statements whose returned cleanup /
  // unsubscribe function is discarded. Type-aware, so it needs TypeScript type
  // information (same `projectService` setup as `mui-x/no-direct-state-access` above).
  {
    files: [`packages/*/src/**/*${EXTENSION_TS}`],
    ignores: [
      '**/*.d.ts',
      `**/*.spec${EXTENSION_TS}`,
      `**/*.test${EXTENSION_TS}`,
      // Codemods are jscodeshift AST transforms with no runtime subscriptions;
      // the only hits are chai assertions in a test-style file.
      'packages/x-codemod/**',
      // Vendored copy of Base UI internals — keep in sync with upstream, don't edit.
      'packages/x-scheduler-internals/src/base-ui-copy/**',
    ],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: dirname,
        projectService: true,
      },
    },
    rules: {
      'mui/no-floating-cleanup': 'error',
    },
  },

  // Common config from core start
  {
    files: [`docs/**/*${EXTENSION_TS}`],
    extends: createDocsConfig(),
    rules: {
      '@next/next/no-img-element': 'off',
      'react/jsx-filename-extension': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },

  {
    files: [`test/regressions/**/*${EXTENSION_TS}`],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react/jsx-filename-extension': 'off',
    },
  },

  {
    files: [`docs/src/pages/**/*${EXTENSION_TS}`, `docs/data/**/*${EXTENSION_TS}`],
    rules: {
      // This most often reports data that is defined after the component definition.
      // This is safe to do and helps readability of the demo code since the data is mostly irrelevant.
      '@typescript-eslint/no-use-before-define': 'off',
      'react/prop-types': 'off',
      'no-alert': 'off',
      'no-console': 'off',
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use the `chance` package with a fixed seed instead for deterministic data.',
        },
      ],
    },
  },

  {
    files: [`docs/data/**/*${EXTENSION_TS}`],
    ignores: [
      // filenames/match-exported sees filename as 'file-name.d'
      // Plugin looks unmaintain, find alternative? (e.g. eslint-plugin-project-structure)
      '**/*.d.ts',
      'docs/data/**/{css,system,tailwind}/*',
    ],
    plugins: {
      'consistent-default-export-name': eslintPluginConsistentName,
    },
    rules: {
      'consistent-default-export-name/default-export-match-filename': ['error'],
      // `role="none"` is an alias for `role="presentation"`, but aria-query treats
      // them differently and reports `aria-hidden` as unsupported on `none`.
      // See https://github.com/jsx-eslint/eslint-plugin-jsx-a11y/issues/1090
      'jsx-a11y/role-supports-aria-props': 'off',
    },
  },

  // Next.js entry points pages
  {
    files: [`docs/pages/**/*${EXTENSION_TS}`],
    rules: {
      'react/prop-types': 'off',
    },
  },
  // Common config from core end

  {
    files: [
      `docs/**/*${EXTENSION_TS}`,
      `packages/*/src/**/*.test${EXTENSION_TS}`,
      `packages/*/src/**/*.spec${EXTENSION_TS}`,
    ],
    ignores: ['**/*.d.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: RESTRICTED_TOP_LEVEL_IMPORTS.map((name) => ({
            name,
            message: 'Use deeper import instead',
          })),
          patterns: [
            {
              group: [
                '@mui/*/*/*',
                // Allow any import depth with any internal packages
                '!@mui/internal-*/**',

                // Exceptions (QUESTION: Keep or remove?)
                '!@mui/x-data-grid/internals/demo',
                '!@mui/x-date-pickers/internals/demo',
                // TODO: export this from /ButtonBase in core. This will break after we move to package exports
                '!@mui/material/ButtonBase/TouchRipple',
                /* Module augmentation for feature flags in Charts. Users should be able to pick the features they need.
                 * so it's useful to allow deeper imports */
                '!@mui/x-charts*/moduleAugmentation/*',
              ],
              message: 'Use less deep import instead',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['packages/x-telemetry/**/*{.tsx,.ts,.js}'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: [
      'packages/x-scheduler/**/*{.tsx,.ts,.js}',
      'packages/x-scheduler-internals/**/*{.tsx,.ts,.js}',
      'packages/x-scheduler-premium/**/*{.tsx,.ts,.js}',
      'packages/x-scheduler-internals-premium/**/*{.tsx,.ts,.js}',
    ],
    rules: {
      // Base UI lint rules
      '@typescript-eslint/no-redeclare': 'off',
      'import/export': 'off',
      'mui/straight-quotes': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/require-returns': 'off',
    },
  },
  {
    // x-studio is internal and unpublished. Its locale interface exposes ~50
    // function-typed string tokens (e.g. `(label) => string`); requiring full
    // JSDoc `@param`/`@returns` on each is low-value documentation busywork, so
    // we disable those two rules here (mirrors the scheduler packages above,
    // which are likewise internal). All other code-quality rules stay on.
    files: [`packages/x-studio/src/**/*${EXTENSION_TS}`],
    rules: {
      'jsdoc/require-param': 'off',
      'jsdoc/require-returns': 'off',
    },
  },
  {
    // Locale files contain intentional typographic quotes — German „…" guillemets
    // and French ' apostrophes / … ellipses — which are the CORRECT translations.
    // `mui/straight-quotes` would flag (and could auto-fix-corrupt) them, so it is
    // disabled for the locale files only.
    files: [`packages/x-studio/src/locales/**/*${EXTENSION_TS}`],
    rules: {
      'mui/straight-quotes': 'off',
    },
  },
  {
    // Prompt-injection guard for the AI middleware's system-prompt builders.
    //
    // `buildAISystemPrompt.ts` ships two sanitizers for the untrusted, state-derived
    // text interpolated into the LLM system prompt:
    //
    // - `sanitizeForPrompt` escapes `<`/`>` only. Correct ONLY for genuinely
    //   multi-line, host-authored regions (`enrichedContext.notes`), where collapsing
    //   newlines would corrupt legitimate prose.
    // - `sanitizeForPromptLine`, and the `promptLine` tagged template built on it,
    //   additionally neutralize every line terminator and `"`. Correct for every
    //   single-line position — which is nearly all of them.
    //
    // Picking the weaker variant for a single-line position is a live injection hole,
    // and it has shipped three separate times (finding M2, the `pageLayout.colSpan`
    // relapse, then H3's `richContext.omitted`). `promptLine` removed the choice
    // structurally, but only inside the one file, and only by convention. This block
    // makes the fourth relapse fail CI.
    //
    // Shape: ban every USE of the identifier — calls, bare callback references
    // (`.map(sanitizeForPrompt)`), and imports (which also closes the
    // `import { sanitizeForPrompt as x }` alias hole). Banning only the callback form
    // would miss the template-literal call that caused all three real relapses. The
    // few legitimately multi-line sites carry an `eslint-disable-next-line` plus a
    // one-line justification, which converts "did the author pick the right
    // sanitizer?" into "did the author consciously opt out?" — a question review can
    // actually answer, one exception at a time.
    //
    // Not uses, so not flagged: the function's own declaration, and its `index.ts`
    // re-export (it is part of the package's public surface). Tests are exempt via
    // `ignores` — `buildAISystemPrompt.test.ts` calls it directly to assert exactly
    // how weak it is.
    files: [`packages/x-studio-ai-middleware/src/**/*${EXTENSION_TS}`],
    ignores: [`**/*${EXTENSION_TEST_FILE}`, `**/*.spec${EXTENSION_TS}`, '**/*.d.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...AI_MIDDLEWARE_RESTRICTED_SYNTAX],
    },
  },
  {
    // Finding H1 — the raw `String` global is banned on the sanitizer/totality surface.
    // MUST come after the package-wide block above and MUST re-state its restrictions:
    // flat config REPLACES a rule's options rather than merging them, so listing only
    // the `String` entries here would switch `sanitizeForPrompt` (and the shared base
    // restrictions) back off for exactly the files that need them most.
    files: AI_MIDDLEWARE_SANITIZER_FILES,
    ignores: [`**/*${EXTENSION_TEST_FILE}`, `**/*.spec${EXTENSION_TS}`, '**/*.d.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...AI_MIDDLEWARE_RESTRICTED_SYNTAX,
        {
          // Call position only — `x.toISOString()` / `n.toString()` are member
          // expressions and must not match.
          selector: 'CallExpression > Identifier.callee[name="String"]',
          message: AI_MIDDLEWARE_STRING_MESSAGE,
        },
        {
          selector: 'NewExpression > Identifier.callee[name="String"]',
          message: AI_MIDDLEWARE_STRING_MESSAGE,
        },
        {
          // An interpolating template literal passed straight to `withTimeout`. The
          // no-interpolation case (a plain string literal) is untouched, and
          // `opLabel`-tagged templates are `TaggedTemplateExpression`s, so they do not
          // match either.
          selector:
            'CallExpression[callee.name="withTimeout"] > TemplateLiteral[expressions.length>0]',
          message: WITH_TIMEOUT_LABEL_MESSAGE,
        },
      ],
    },
  },
  ...[
    'x-charts',
    'x-charts-pro',
    'x-charts-premium',
    'x-codemod',
    'x-data-grid',
    'x-data-grid-pro',
    'x-data-grid-premium',
    'x-data-grid-generator',
    'x-date-pickers',
    'x-date-pickers-pro',
    'x-scheduler',
    'x-scheduler-premium',
    'x-scheduler-internals',
    'x-scheduler-internals-premium',
    'x-tree-view',
    'x-tree-view-pro',
    'x-license',
    'x-telemetry',
  ].map((pkgName) => ({
    files: [`packages/${pkgName}/src/**/*${EXTENSION_TS}`],
    ignores: ['**/*.d.ts', '**/*.spec{.ts,.tsx}', '**/*.test{.ts,.tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...RESTRICTED_TOP_LEVEL_IMPORTS.map((pkName) => ({
              name: pkName,
              message: 'Use relative import instead',
            })),
            {
              name: '@mui/x-charts-vendor/d3-scale',
              importNames: ['scaleBand', 'scalePoint'],
              message:
                'Use the scaleBand and scalePoint implementations from @mui/x-charts/internals/scales instead',
            },
          ],
          patterns: [
            {
              group: ['@mui/*/*/*'],
              message: 'Use less deep import instead',
            },
            {
              group: [`@mui/${pkgName}/*`, `@mui/${pkgName}/**`],
              message: 'Use relative import instead',
            },
          ],
        },
      ],
    },
  })),
  ...[
    packageFilesWithReactCompiler.length > 0
      ? {
          files: packageFilesWithReactCompiler,
          rules: {
            'react-compiler/react-compiler': 'error',
          },
        }
      : {},
  ],

  // We can't use the react-compiler plugin in the base-ui-utils folder because the Base UI team doesn't use it yet.
  {
    files: ['packages/x-scheduler-internals/src/base-ui-copy/**/*{.tsx,.ts,.js}'],
    rules: {
      'react-compiler/react-compiler': 'off',
    },
  },

  {
    // `react-hooks/refs` is `off` package-wide (see the "MUI X Overrides" block), so a
    // render-phase ref write — a side effect in the render body, which React may discard
    // for a render that never commits, or run twice — was never flagged and became a
    // local convention. Inert today (nothing here renders under Suspense or a
    // transition), but it is the kind of latent breakage that only shows up once one of
    // those is introduced, at which point the cause is very hard to see.
    //
    // Turned on for the canvas subtree, where the whole cluster (10 writes across 6
    // files: `useStudioDraggable` ×4, `useStudioDropTarget` ×2, `InsertionPoint`,
    // `WidgetGap`, `RowResizeHandle`, `StudioCanvas`) has been converted to effect-based
    // ref updates. Every reader there is a pragmatic-drag-and-drop event handler or an
    // unmount cleanup, so none of them can observe `.current` before the first effect
    // flush — which is what made the conversion safe rather than merely tidy.
    //
    // Deliberately NOT the whole package yet: 11 further render-phase WRITES remain
    // (`StudioFiltersDrawer/FilterValueInput` ×4, `.../DateValueInput` ×2,
    // `.../FilterCard` ×1, `StudioChatPanel/useChatThreads` ×2,
    // `.../useSpeechRecognition` ×1, `StudioWidgetEditDialog/FilterRow` ×1), plus 20
    // weaker "ref passed to a function" diagnostics. Widen the glob as each directory is
    // cleaned — a rule that holds for part of the package is worth more than one that
    // has to be reverted.
    files: [`packages/x-studio/src/components/StudioCanvas/**/*${EXTENSION_TS}`],
    rules: { 'react-hooks/refs': 'error' },
  },

  {
    // TODO: typescript namespaces found to be harmful. Refactor to different patterns. More info: https://github.com/mui/mui-x/pull/19071
    files: [
      `packages/x-scheduler/src/**/*${EXTENSION_TS}`,
      `packages/x-scheduler-premium/src/**/*${EXTENSION_TS}`,
      `packages/x-scheduler-internals/src/**/*${EXTENSION_TS}`,
      `packages/x-scheduler-internals-premium/src/**/*${EXTENSION_TS}`,
      `packages/x-virtualizer/src/**/*${EXTENSION_TS}`,
    ],
    rules: {
      '@typescript-eslint/no-namespace': 'off',
    },
  },
);
