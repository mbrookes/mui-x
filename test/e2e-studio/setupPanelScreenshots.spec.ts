/**
 * Widget-config-panel documentation screenshots.
 *
 * Captures one screenshot per fixture in `examples/x-studio/src/screenshotScenarios.ts`,
 * rendered in isolation via `ScreenshotHarness.tsx` (`/?panelScreenshot=<scenarioId>`).
 * This is a documentation/review tool, not a CI visual-regression gate — output is
 * written locally and is not compared against a baseline or uploaded anywhere.
 *
 * Run with the example app's dev server already running (`pnpm --filter x-studio-example dev`)
 * or let Playwright start it (see playwright.config.ts's `webServer`):
 *
 *   pnpm exec playwright test setupPanelScreenshots.spec.ts --config test/e2e-studio/playwright.config.ts
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
  SCREENSHOT_SCENARIOS,
  type ScreenshotInteractionStep,
} from 'x-studio-example/src/screenshotScenarios';

const OUTPUT_DIR = path.resolve(import.meta.dirname, 'screenshots/setup-panels');

function resolveStepLocator(page: Page, step: ScreenshotInteractionStep) {
  if (step.buttonName) {
    return page.getByRole('button', { name: step.buttonName, exact: true });
  }
  if (step.menuItemName) {
    return page.getByRole('menuitem', { name: step.menuItemName });
  }
  if (step.formControlText) {
    return page
      .locator('.MuiFormControl-root', { hasText: step.formControlText })
      .getByRole('combobox');
  }
  // Not getByLabel: once the popper is open, its listbox shares the same
  // aria-labelledby as the input, making a plain label lookup ambiguous.
  return page.getByRole('combobox', { name: step.label! });
}

async function runInteraction(page: Page, step: ScreenshotInteractionStep) {
  const locator = resolveStepLocator(page, step);

  if (step.action === 'hover') {
    await locator.hover();
    // Let the MUI Tooltip's show-delay + fade transition finish.
    await page.waitForTimeout(400);
  } else {
    await locator.click();
    // A native Select opens its menu on click alone. Autocomplete (openOnFocus
    // unset) sometimes does too — but not reliably (e.g. a field that already
    // has a value renders as a read-only-looking chip) — so force it open with
    // ArrowDown unless the click already expanded it.
    if (
      step.label &&
      !step.formControlText &&
      (await locator.getAttribute('aria-expanded')) !== 'true'
    ) {
      await locator.press('ArrowDown');
    }
    // Let the opening Popper's fade transition finish.
    await page.waitForTimeout(200);
  }
}

test.describe('Setup panel documentation screenshots', () => {
  test.beforeAll(async () => {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    const manifest = SCREENSHOT_SCENARIOS.map((s) => ({
      id: s.id,
      panel: s.panel,
      description: s.description,
      path: `${s.panel}/${s.id}.png`,
    }));
    await fs.writeFile(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  });

  for (const scenario of SCREENSHOT_SCENARIOS) {
    test(`captures ${scenario.id}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(`/?panelScreenshot=${scenario.id}`);

      const root = page.locator('[data-testid="screenshot-root"]');
      await expect(root).toBeVisible();

      // Steps must run in DOM order — each depends on the previous step's resulting
      // state (e.g. opening a menu before clicking one of its items) — so they
      // cannot be parallelized.
      for (const step of scenario.interactions ?? []) {
        // eslint-disable-next-line no-await-in-loop
        await runInteraction(page, step);
      }

      const panelDir = path.join(OUTPUT_DIR, scenario.panel);
      await fs.mkdir(panelDir, { recursive: true });
      const screenshotPath = path.join(panelDir, `${scenario.id}.png`);

      if (scenario.interactions?.length) {
        // Open dropdowns/menus/tooltips render in a MUI Popper portaled onto
        // <body>, outside the drawer root — capture the full page instead.
        await page.screenshot({ path: screenshotPath });
      } else {
        await root.screenshot({ path: screenshotPath });
      }

      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  }
});
