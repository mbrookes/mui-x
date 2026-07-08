/**
 * End-to-end tests for the x-studio example app.
 *
 * The app is a single-page dashboard whose 100%-stacked bar chart plots, for
 * every component library, the relative share of each data grid library
 * among non-fork GitHub repos that declare both as dependencies (see
 * `examples/x-studio/src/connectors/githubLibraryUsageSource.ts`). Because
 * the underlying data comes from a live, rate-limited, token-gated
 * third-party API (GitHub code search) proxied through this app's own API
 * server, this suite only asserts the app shell and widgets render
 * correctly — it does not assert on actual GitHub search results, which
 * would make CI flaky and require a secret. Without GITHUB_SEARCH_TOKEN
 * configured on the API server, the connector returns an empty row set and
 * the chart renders its empty state; the assertions below hold either way.
 *
 * The dashboard has a single page, so the app toolbar shows the dashboard
 * title as plain text rather than a page-tab bar (AppToolbar only renders
 * tabs when there's more than one page).
 *
 * Selector conventions:
 * - Widget card: locator('[data-widget-card][aria-label="Widget: <title>"]')
 *   (The aria-label is set by the `filtersSectionWidgetTitle` locale string,
 *   which defaults to `Widget: <title>`.)
 */

import { test, expect, type Page } from '@playwright/test';

function widgetCard(page: Page, widgetTitle: string) {
  return page.locator(`[data-widget-card][aria-label="Widget: ${widgetTitle}"]`);
}

test.describe('Smoke: Library Adoption page loads', () => {
  test('renders the intro and chart widgets without JS errors', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/');
    await page.locator('[data-widget-card]').first().waitFor({ state: 'visible' });

    const introCard = widgetCard(page, 'Component Library × Data Grid Adoption');
    await expect(introCard).toBeVisible();

    const chartCard = widgetCard(page, 'Repositories using both libraries');
    await expect(chartCard).toBeVisible();

    expect(jsErrors).toHaveLength(0);
  });
});
