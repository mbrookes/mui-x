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
import { test, expect } from '@playwright/test';
import { SCREENSHOT_SCENARIOS } from '../../examples/x-studio/src/screenshotScenarios';

const OUTPUT_DIR = path.resolve(import.meta.dirname, 'screenshots/setup-panels');

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

      const panelDir = path.join(OUTPUT_DIR, scenario.panel);
      await fs.mkdir(panelDir, { recursive: true });
      await root.screenshot({ path: path.join(panelDir, `${scenario.id}.png`) });

      expect(errors, errors.join('\n')).toHaveLength(0);
    });
  }
});
