import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CSS_GUARD_MODULES,
  REPO_ROOT,
  findCssGuardSites,
  findGuardReExports,
  readGuardNames,
} from 'test/utils/cssGuardScan';

/**
 * The CSS-sanitizer guard family's call-site inventory: every shipped call site, and the test
 * measured to fail when that site stops calling its guard.
 *
 * ── Why an inventory, rather than N more assertions ──
 *
 * These guards are the boundary between a doc-authored value — reachable through
 * `loadSerializedState(data: unknown)` and the AI `update_widget` tool call — and an Emotion
 * `sx` property value, which Emotion does not escape. `resolveTextFontFamily`'s own docblock
 * names the payload the allow-list stops. Every guard is thoroughly unit-tested in
 * `cssValueValidation.test.ts` / `textFontFamily.test.ts`, and none of those tests can tell
 * you whether every place that should CALL a guard still does.
 *
 * That question was answered once by hand, wrongly. The commit that closed it recorded:
 * *"Completes the repo-wide enumeration ... Of the 15 shipped sites, 12 had no discriminating
 * test; this closes the final three."* There were 29 sites for the guards it named, not 15,
 * and four of the fourteen it never counted had no discriminating test — `textTitleFontSize`
 * and `textTitleFontFamily` in `StudioWidgetCard`'s title `sx`, and `textSubtitleFontSize`
 * and `textSubtitleFontFamily` in `StudioTextWidget`'s subtitle `sx`, the last two being lines
 * byte-identical to pinned body-text siblings ten lines below them. All four survived the full
 * 4957-test project.
 *
 * The lesson is not "that enumeration was careless". It is that a remediation pass which
 * enumerates a guard's call sites BY HAND misses the second site exactly as easily as the code
 * it is fixing, so the count must not live in a human's head, a comment, or a commit message.
 * It lives in `test/utils/cssGuardScan.ts`, derived from the TypeScript AST, and this file
 * checks the derived list against the rows below. Nothing here says "all N sites"; the number
 * is whatever the scan returns, and {@link CSS_GUARD_INVENTORY} has to match it.
 *
 * ── What a row claims, and what establishes it ──
 *
 * `pinnedBy` names a test measured to fail when that call site's guard call is removed —
 * replaced by a pass-through of its argument, with the fallback argument (if any) preserved so
 * the failure is about sanitization and not about a lost default. Every row below was measured
 * that way; the recorded test is the one that went red. This file does not re-run those
 * mutations (it cannot); it makes sure no site can be added, moved, aliased, or re-argued
 * without someone doing it, because a new site with no row fails the completeness test and a
 * row with no matching test in the named file fails the last one.
 *
 * `pinnedBy.test` is the title AS WRITTEN in the test file, so an `it.each` row keeps its `%s`
 * placeholder rather than the interpolated case that happened to go red — the row has to point
 * at something a reader can find by searching, and one `it.each` legitimately covers several
 * sites (the five `pageTheme` rows below share two of them).
 */

interface GuardSiteEntry {
  /** `<file>:<guard>(<first argument>)#<n>`, exactly as the scan derives it. */
  site: string;
  /** What the value is, and why it needs the guard. A claim a reader can check. */
  what: string;
  /** The test measured to fail when this site stops calling its guard. */
  pinnedBy: { file: string; test: string };
}

const CSS_GUARD_INVENTORY: GuardSiteEntry[] = [
  {
    site: 'packages/x-studio/src/components/StudioCanvas/StudioCanvas.tsx:sanitizeCssColor(activePage?.theme?.pageBackground)#0',
    what: 'the active page\'s doc-authored background colour, interpolated into the canvas `sx`',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioCanvas/StudioCanvas.pageBackgroundSanitization.test.tsx',
      test: 'falls back to unset instead of propagating a CSS-injection payload',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:isSafeTextAlign(widget.config.textTitleAlign)#0',
    what: 'the text widget title\'s alignment keyword, spread into the title `sx`',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'rejects an invalid align value instead of propagating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:resolveTextFontFamily(widget.config.textTitleFontFamily)#0',
    what: 'the title\'s font-family stack. This guard\'s docblock names the exfiltration payload its allow-list stops',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'drops a CSS-injecting textTitleFontFamily instead of interpolating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:sanitizeCssColor(pageTheme?.cardBackground)#0',
    what: '`StudioPage.theme.cardBackground`, into the card `sx`',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'drops a CSS-injecting pageTheme.%s instead of interpolating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:sanitizeCssColor(pageTheme?.cardBorderColor)#0',
    what: '`StudioPage.theme.cardBorderColor`, into the card `sx`',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'drops a CSS-injecting pageTheme.%s instead of interpolating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:sanitizeCssColor(widget.config.textTitleColor)#0',
    what: 'the text widget title\'s colour, into the title `sx`',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'drops a CSS-injecting textTitleColor instead of interpolating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:sanitizeFiniteNumber(pageTheme?.cardBorderWidth)#0',
    what: 'typed `number` on `StudioPageTheme`, but that type is not enforced at the `loadSerializedState`/AI boundary',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'drops a CSS-injecting pageTheme.%s instead of interpolating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:sanitizeFiniteNumber(pageTheme?.cardPadding)#0',
    what: 'same numeric `StudioPageTheme` field family as `cardBorderWidth`',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'drops a CSS-injecting pageTheme.%s instead of interpolating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:sanitizeFiniteNumber(pageTheme?.cardRadius)#0',
    what: 'same numeric `StudioPageTheme` field family; a non-finite value would emit `NaNpx` geometry',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'drops a CSS-injecting pageTheme.%s instead of interpolating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:sanitizeFontSize(widget.config?.titleFontSize)#0',
    what: 'every widget card\'s title font size',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'drops a CSS-injecting titleFontSize instead of interpolating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:sanitizeFontSize(widget.config.textTitleFontSize)#0',
    what: 'the text widget title\'s own font size, in the same `sx` object as `titleFontSize`',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'drops a CSS-injecting textTitleFontSize instead of interpolating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.tsx:sanitizeFontWeight(widget.config.textTitleFontWeight)#0',
    what: 'the title\'s numeric font weight, clamped to the valid CSS range',
    pinnedBy: {
      file: 'packages/x-studio/src/components/StudioWidgetCard/StudioWidgetCard.titleStyleSanitization.test.tsx',
      test: 'rejects an out-of-range/invalid fontWeight instead of propagating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioChartWidget/chartTypeDefs.tsx:sanitizeFiniteNumber(config.funnelGap)#0',
    what: 'the funnel chart\'s gap, forwarded as a numeric chart prop',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioChartWidget/chartTypeDefs.test.tsx',
      test: 'sanitizes %s funnelGap to undefined (chart default)',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioChartWidget/StudioBarChart.tsx:sanitizeFiniteNumber(barMinBandSize)#0',
    what: 'the bar chart\'s minimum band size. A BELOW-MINIMUM value passes the `<= MAX_BAR_MIN_BAND_SIZE` clause beside it and is caught only here',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioChartWidget/StudioBarChart.test.tsx',
      test: 'ignores a below-minimum barMinBandSize and WARNS',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioGridWidget/StudioGridWidget.tsx:isSafeFontWeightKeyword(rule.style.fontWeight)#0',
    what: 'a conditional-format rule\'s font-weight keyword',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioGridWidget/StudioGridWidget.conditionalFormatSanitization.test.tsx',
      test: 'rejects an invalid fontWeight value instead of propagating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioGridWidget/StudioGridWidget.tsx:sanitizeCssColor(rule.style.backgroundColor)#0',
    what: 'a conditional-format rule\'s background, into a generated stylesheet rule',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioGridWidget/StudioGridWidget.conditionalFormatSanitization.test.tsx',
      test: 'drops a CSS-injecting backgroundColor instead of interpolating it into sx',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioGridWidget/StudioGridWidget.tsx:sanitizeCssColor(rule.style.color)#0',
    what: 'a conditional-format rule\'s text colour, into the same generated rule',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioGridWidget/StudioGridWidget.conditionalFormatSanitization.test.tsx',
      test: 'drops a CSS-injecting color instead of interpolating it into sx',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioGridWidget/StudioGridWidget.tsx:sanitizeCssIdentifierToken(widget.id)#0',
    what: 'the widget id, interpolated into a generated CSS class SELECTOR rather than a property value',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioGridWidget/StudioGridWidget.conditionalFormatSanitization.test.tsx',
      test: 'sanitizes a widget id containing CSS-breaking characters before building the selector key',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioGridWidget/StudioGridWidget.tsx:sanitizeFiniteNumber(widget.config.gridHeight)#0',
    what: 'the grid\'s rendered height',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioGridWidget/StudioGridWidget.conditionalFormatSanitization.test.tsx',
      test: 'falls back to the default height for a CSS-injecting gridHeight',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.tsx:isSafeTextAlign(config.textBodyAlign)#0',
    what: 'the body text\'s alignment keyword',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.test.tsx',
      test: 'rejects an invalid textBodyAlign/textSubtitleAlign value instead of propagating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.tsx:isSafeTextAlign(config.textSubtitleAlign)#0',
    what: 'the subtitle\'s alignment keyword',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.test.tsx',
      test: 'rejects an invalid textBodyAlign/textSubtitleAlign value instead of propagating it',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.tsx:resolveTextFontFamily(config.textBodyFontFamily)#0',
    what: 'the body text\'s font-family stack',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.test.tsx',
      test: 'drops a CSS-injecting textBodyFontFamily instead of interpolating it verbatim',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.tsx:resolveTextFontFamily(config.textSubtitleFontFamily)#0',
    what: 'the subtitle\'s font-family stack — the twin of the body one, and unpinned until it was measured',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.test.tsx',
      test: 'drops a CSS-injecting textSubtitleFontFamily instead of interpolating it verbatim',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.tsx:sanitizeCssColor(config.textBodyColor)#0',
    what: 'the body text\'s colour',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.test.tsx',
      test: 'drops a CSS-injecting textBodyColor instead of interpolating it verbatim',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.tsx:sanitizeCssColor(config.textSubtitleColor)#0',
    what: 'the subtitle\'s colour',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.test.tsx',
      test: 'drops a CSS-injecting textSubtitleColor instead of interpolating it verbatim',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.tsx:sanitizeFontSize(config.textBodyFontSize)#0',
    what: 'the body text\'s font size, hoisted to one call so removing it is observable',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.test.tsx',
      test: 'falls back to the theme default for a non-numeric textBodyFontSize',
    },
  },
  {
    site: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.tsx:sanitizeFontSize(config.textSubtitleFontSize)#0',
    what: 'the subtitle\'s font size, hoisted to one call so removing it is observable',
    pinnedBy: {
      file: 'packages/x-studio/src/components/widgets/StudioTextWidget/StudioTextWidget.test.tsx',
      test: 'drops a CSS-injecting textSubtitleFontSize instead of interpolating it verbatim',
    },
  },
  {
    site: 'packages/x-studio/src/internals/builtinWidgetDefs.ts:sanitizeFiniteNumber((widget as StudioWidgetOf<\'grid\'>).config.gridHeight)#0',
    what: 'the grid\'s SKELETON height on the pre-paint path, reading the same `config.gridHeight` the grid itself does',
    pinnedBy: {
      file: 'packages/x-studio/src/internals/builtinWidgetDefs.test.ts',
      test: 'falls back to the default height for %s',
    },
  },
  {
    site: 'packages/x-studio/src/internals/cssValueValidation.ts:isSafeCssColor(value)#0',
    what: 'guard-internal: `sanitizeCssColor` delegating to its own allow-list',
    pinnedBy: {
      file: 'packages/x-studio/src/internals/cssValueValidation.test.ts',
      test: 'rejects a CSS-injecting string',
    },
  },
  {
    site: 'packages/x-studio/src/internals/cssValueValidation.ts:sanitizeFiniteNumber(value)#0',
    what: 'guard-internal: `sanitizeFontSize` is a `min = 1` wrapper, and this is that delegation',
    pinnedBy: {
      file: 'packages/x-studio/src/internals/cssValueValidation.test.ts',
      test: 'rejects non-numeric, non-finite, zero/negative (for font size), and below-min values',
    },
  },
  {
    site: 'packages/x-studio/src/internals/textFontFamily.ts:isSafeFontFamily(value)#0',
    what: 'guard-internal: `resolveTextFontFamily` running a non-keyword literal stack through the allow-list',
    pinnedBy: {
      file: 'packages/x-studio/src/internals/textFontFamily.test.ts',
      test: 'returns undefined for a CSS-injecting literal instead of passing it through verbatim',
    },
  },
];

describe('CSS-sanitizer guard family — call-site inventory', () => {
  const guards = readGuardNames();
  const found = findCssGuardSites();

  it('reads the family from the guard modules themselves', () => {
    // Not a hard-coded list: export a new guard from either module and its call sites are
    // scanned from that moment, which is what forces them into the inventory below.
    expect(guards.length).toBeGreaterThan(0);
    expect(CSS_GUARD_MODULES.every((m) => existsSync(join(REPO_ROOT, m)))).toBe(true);
  });

  it('has no barrel re-exporting a guard module', () => {
    // The scan resolves import bindings per file and does not follow re-export chains, so a
    // barrel would hide every consumer importing through it — and hide it by making the site
    // count DROP, which is the direction that looks like success. Fail loudly instead.
    expect(findGuardReExports()).toEqual([]);
  });

  it('finds exactly the call sites the inventory records — no more, no fewer', () => {
    // The only assertion that would have caught the "15 sites" claim. Adding a call site fails
    // this test until a row is written for it, and a row's identity is the call's own text, so
    // rewriting a call's argument fails it too rather than silently re-pointing the row.
    expect(found.map((s) => s.site).sort()).toEqual(CSS_GUARD_INVENTORY.map((row) => row.site).sort());
  });

  it.each(CSS_GUARD_INVENTORY)('names a live pinning test for $site', (entry) => {
    const file = join(REPO_ROOT, entry.pinnedBy.file);
    expect(existsSync(file), `missing test file ${entry.pinnedBy.file}`).toBe(true);
    expect(
      readFileSync(file, 'utf8'),
      `${entry.pinnedBy.file} no longer contains the test named for ${entry.site}`,
    ).toContain(entry.pinnedBy.test);
  });
});
