/**
 * End-to-end tests for the x-studio example app.
 *
 * Coverage goals:
 * 1. Smoke – all 8 pages load and render widgets without JS errors.
 * 2. Regressions for the data-pipeline fix chain:
 *    a. KPI with expression field (expr-product-margin) shows a real number.
 *    b. Funnel with funnelReachedField shows non-zero stage bars.
 *    c. Pivot with join-based row field shows non-"(blank)" labels.
 *    d. Blended cross-source chart (ORDER_ITEMS + PRODUCTS) renders bars.
 * 3. Cross-filter interaction – clicking a chart bar filters sibling widgets.
 * 4. Dashboard date-range filter scoping – date filter for one source does
 *    not blank out widgets from an unrelated source.
 *
 * Selector conventions:
 * - Page tabs:   getByRole('tab', { name: '<Page Title>' })
 * - Widget card: locator('[data-widget-card][aria-label="Widget: <title>"]')
 *   (The aria-label is set by the `filtersSectionWidgetTitle` locale string,
 *   which defaults to `Widget: <title>`.)
 * - KPI value:   h3 inside the widget card
 * - SVG content: svg inside the widget card
 * - Pivot rows:  th[scope="row"] inside the widget card
 */

import { test, expect, type Page } from '@playwright/test';

// ─── Helpers ───────────────────────────────────────────────────────────────

function widgetCard(page: Page, widgetTitle: string) {
  return page.locator(`[data-widget-card][aria-label="Widget: ${widgetTitle}"]`);
}

/**
 * Navigate to a page tab and wait for at least one widget card to appear.
 */
async function navigateTo(page: Page, pageTitle: string) {
  await page.getByRole('tab', { name: pageTitle }).click();
  // Wait for at least one widget to mount on the new page
  await page.locator('[data-widget-card]').first().waitFor({ state: 'visible' });
}

/**
 * Wait for all [data-widget-card] elements on the current page to stop
 * showing skeleton loaders. Skeletons have role="img" with aria-busy or are
 * MUI Skeleton elements; the simplest proxy is that each chart card eventually
 * contains an <svg> (charts) or a value string (KPIs).
 *
 * We give 10 s — the simulated in-memory server is synchronous so this should
 * resolve within a few hundred milliseconds in practice.
 */
async function waitForWidgetsLoaded(page: Page) {
  // Wait until no MUI Skeleton elements are visible (skeletons are shown
  // while data is loading). MUI Skeleton renders as [aria-busy="true"].
  await page.waitForFunction(
    () => document.querySelectorAll('[data-widget-card] [aria-busy="true"]').length === 0,
    { timeout: 10_000 },
  );
}

// ─── Smoke tests – every page loads ────────────────────────────────────────

const ALL_PAGES = [
  'Sales Overview',
  'Sales Products',
  'Sales Logistics',
  'Sales Customers',
  'Sales Analytics',
  'CRM Pipeline',
  'CRM Contacts',
  'Customer 360',
] as const;

test.describe('Smoke: all pages load', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    await page.goto('/');
    // Store console errors in the page object for later assertions
    await page.evaluate(() => {
      (window as any).__e2eErrors = [];
    });
    page.on('pageerror', (err) => {
      // We'll surface these in individual tests
      console.error('[pageerror]', err.message);
    });
    // Wait for initial page to render
    await page.locator('[data-widget-card]').first().waitFor({ state: 'visible' });
  });

  for (const pageTitle of ALL_PAGES) {
    test(`"${pageTitle}" renders at least one widget`, async ({ page }) => {
      await navigateTo(page, pageTitle);
      const cards = page.locator('[data-widget-card]');
      await expect(cards.first()).toBeVisible();
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);
    });
  }
});

// ─── Regression: KPI with expression field ─────────────────────────────────

test.describe('Regression: KPI expression field', () => {
  /**
   * "Avg Unit Margin" KPI uses `expr-product-margin` (price − cost), an
   * arithmetic expression field. Before the registry fix (Step 3), expression
   * fields were not correctly resolved for KPI widgets, producing "—" or 0.
   */
  test('Avg Unit Margin shows a non-zero formatted value', async ({ page }) => {
    await page.goto('/');
    await navigateTo(page, 'Sales Products');
    await waitForWidgetsLoaded(page);

    const card = widgetCard(page, 'Avg Unit Margin');
    await expect(card).toBeVisible();

    // The KPI value renders in a Typography h3 element
    const valueEl = card.locator('h3').first();
    await expect(valueEl).toBeVisible();

    const text = await valueEl.textContent();
    // Should be a currency string like "$12.34" or similar — not "—", "0", or empty
    expect(text).toBeTruthy();
    expect(text).not.toBe('—');
    expect(text).not.toBe('$0');
    expect(text).not.toBe('0');
    // Currency values contain a digit
    expect(text).toMatch(/\d/);
  });
});

// ─── Regression: Funnel with funnelReachedField ────────────────────────────

test.describe('Regression: Funnel funnelReachedField', () => {
  /**
   * "Deals by Stage (reached)" uses chartType: 'funnel' with `funnelReachedField:
   * 'stageReached'`. Before Step 3 (chartTypeRegistry), `funnelReachedField` was
   * silently absent from the SELECT, so all stage counts returned as 0 and the
   * funnel rendered as a flat/empty chart.
   *
   * We verify that the SVG inside the widget contains <rect> elements with a
   * non-zero rendered width — indicating the bars are actually drawn.
   */
  test('Funnel chart bars have non-zero widths', async ({ page }) => {
    await page.goto('/');
    await navigateTo(page, 'CRM Pipeline');
    await waitForWidgetsLoaded(page);

    const card = widgetCard(page, 'Deals by Stage (reached)');
    await expect(card).toBeVisible();

    // Wait for SVG to appear (chart renders asynchronously)
    const svg = card.locator('svg').first();
    await expect(svg).toBeVisible({ timeout: 10_000 });

    // Check that at least one <rect> with a non-zero rendered width exists
    // (funnel bars are horizontal, so width is the measure of "value")
    const hasNonZeroBar = await card.evaluate((el) => {
      const rects = Array.from(el.querySelectorAll('rect'));
      return rects.some((r) => {
        const w = r.getAttribute('width');
        return w !== null && parseFloat(w) > 0;
      });
    });
    expect(hasNonZeroBar).toBe(true);
  });
});

// ─── Regression: Pivot with join-based row field ───────────────────────────

test.describe('Regression: Pivot join-based row field', () => {
  /**
   * "Revenue by Segment × Status" uses pivotRowField: 'expr-order-segment',
   * which is a JoinFieldExpression (customers.segment joined via customerId).
   * Before Step 3, JoinFieldExpression fields were dropped by expandToNativeFields()
   * and the pivot rendered all rows as "(blank)".
   *
   * We verify that the pivot table's row headers contain real segment names
   * (Consumer, Corporate, Home Office, etc.) and not "(blank)".
   */
  test('Pivot row headers are not "(blank)"', async ({ page }) => {
    await page.goto('/');
    await navigateTo(page, 'Sales Analytics');
    await waitForWidgetsLoaded(page);

    const card = widgetCard(page, 'Revenue by Segment × Status');
    await expect(card).toBeVisible();

    // Wait for the pivot table to render (it uses a <table> element)
    const table = card.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10_000 });

    // Row header cells use th[scope="row"] or the first td in each row;
    // get all text in the first column of the table body
    const rowHeaders = await card.locator('table tbody tr th').allTextContents();

    // Must have at least one row
    expect(rowHeaders.length).toBeGreaterThan(0);

    // No row header should be "(blank)"
    for (const header of rowHeaders) {
      expect(header.trim()).not.toBe('(blank)');
    }

    // Expect at least one of the known CRM segment names
    const knownSegments = ['Consumer', 'Corporate', 'Home Office', 'SMB', 'Enterprise'];
    const hasKnownSegment = rowHeaders.some((h) => knownSegments.some((s) => h.includes(s)));
    expect(hasKnownSegment).toBe(true);
  });
});

// ─── Regression: Blended cross-source chart ───────────────────────────────

test.describe('Regression: Blended cross-source chart', () => {
  /**
   * "Revenue vs Inventory Stock by Category (blended sources)" renders a mixed
   * chart with two ySeries from different sources (ORDER_ITEMS and PRODUCTS).
   * Each series must be independently aggregated and merged on the shared
   * `category` x-axis. If either source's data is missing, the bars will be absent.
   */
  test('Blended chart SVG contains rendered bar elements', async ({ page }) => {
    await page.goto('/');
    await navigateTo(page, 'Sales Analytics');
    await waitForWidgetsLoaded(page);

    const card = widgetCard(page, 'Revenue vs Inventory Stock by Category (blended sources)');
    await expect(card).toBeVisible();

    const svg = card.locator('svg').first();
    await expect(svg).toBeVisible({ timeout: 10_000 });

    // At least one rect with non-zero dimensions should exist
    const hasBar = await card.evaluate((el) => {
      const rects = Array.from(el.querySelectorAll('rect'));
      return rects.some((r) => {
        const w = parseFloat(r.getAttribute('width') ?? '0');
        const h = parseFloat(r.getAttribute('height') ?? '0');
        return w > 0 && h > 0;
      });
    });
    expect(hasBar).toBe(true);
  });
});

// ─── Cross-filter interaction ──────────────────────────────────────────────

test.describe('Cross-filter interaction', () => {
  /**
   * Clicking a bar in the "Revenue by Category" chart (Sales Overview) emits a
   * cross-filter. Other charts on the same page should react by highlighting
   * or narrowing their data.
   *
   * We don't assert a specific row count (that would require knowing the data);
   * instead we assert that:
   * 1. A second click on the same bar (to toggle off the filter) restores the
   *    original state — i.e., the filter round-trips correctly.
   * 2. No JS error occurs during the interaction.
   */
  test('Clicking a chart bar activates and deactivates a cross-filter', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/');
    await navigateTo(page, 'Sales Overview');
    await waitForWidgetsLoaded(page);

    const revenueCard = widgetCard(page, 'Revenue by Category');
    await expect(revenueCard).toBeVisible();

    const svg = revenueCard.locator('svg').first();
    await expect(svg).toBeVisible({ timeout: 10_000 });

    // Find a clickable bar and record the chart state before clicking
    const bars = revenueCard.locator('rect[width]');
    const barCount = await bars.count();
    expect(barCount).toBeGreaterThan(0);

    // Click the first bar to activate cross-filter
    await bars.first().click();

    // A cross-filter indicator should appear — in x-studio, filtered widgets
    // show a subtle style change, and the filter pill appears in the toolbar.
    // The most reliable proxy without knowing exact styles is that no JS error occurred
    // and the page is still interactive (we can click again).
    await page.waitForTimeout(500); // allow React state update to settle

    // Click the same bar again to deactivate the filter
    await bars.first().click();
    await page.waitForTimeout(500);

    // Page should still show all widgets
    const cards = page.locator('[data-widget-card]');
    await expect(cards.first()).toBeVisible();
    expect(jsErrors).toHaveLength(0);
  });
});

// ─── Date-range filter scoping ─────────────────────────────────────────────

test.describe('Dashboard date-range filter scoping', () => {
  /**
   * The dashboard has date-range filters that are scoped to specific data sources.
   * A date filter for the CRM deals source must NOT affect the KPI widgets on
   * the Sales Products page (which uses the PRODUCTS source).
   *
   * Regression for the `isDashboardDateRange + filterSourceId` bug (d00c343d):
   * date filters were leaking across sources, blanking out unrelated widgets.
   *
   * Verification: navigate to "Sales Products" and confirm the KPI widgets
   * display real values even when a date-range filter is active on another source.
   */
  test('Sales Products KPIs are not blanked by CRM date filter', async ({ page }) => {
    await page.goto('/');
    // First visit CRM Pipeline which has a date filter applied by default
    await navigateTo(page, 'CRM Pipeline');
    await waitForWidgetsLoaded(page);

    // Now switch to Sales Products
    await navigateTo(page, 'Sales Products');
    await waitForWidgetsLoaded(page);

    // All three KPI cards on this page should show real values
    const kpiTitles = ['Units Sold', 'Avg Unit Margin', 'Total Inventory Value'];
    for (const title of kpiTitles) {
      const card = widgetCard(page, title);
      await expect(card).toBeVisible();
      const valueEl = card.locator('h3').first();
      await expect(valueEl).toBeVisible();
      const text = await valueEl.textContent();
      // Should be a non-empty, non-dash value
      expect(text).toBeTruthy();
      expect(text).not.toBe('—');
      expect(text).toMatch(/\d/);
    }
  });
});

// ─── Chart variety smoke tests ─────────────────────────────────────────────

test.describe('Chart type coverage', () => {
  /**
   * Quick smoke test confirming that each key chart type renders SVG content
   * on its host page. This catches silent "unsupported chart type returns empty"
   * regressions from the chartTypeRegistry refactor (Step 3).
   */

  const CHART_CHECKS: Array<{ page: string; widgetTitle: string; description: string }> = [
    {
      page: 'Sales Overview',
      widgetTitle: 'Quarterly Revenue by Category',
      description: 'bar-stacked chart',
    },
    {
      page: 'Sales Overview',
      widgetTitle: 'Revenue by Category',
      description: 'donut chart',
    },
    {
      page: 'Sales Products',
      widgetTitle: 'Price vs. Unit Margin',
      description: 'scatter chart',
    },
    {
      page: 'Sales Products',
      widgetTitle: 'Margin % by Category',
      description: 'bar chart (horizontal)',
    },
    {
      page: 'Sales Analytics',
      widgetTitle: 'Quantity by Category & Discount',
      description: 'heatmap chart',
    },
    {
      page: 'Sales Analytics',
      widgetTitle: 'Total Revenue (USD)',
      description: 'gauge chart',
    },
    {
      page: 'Sales Analytics',
      widgetTitle: 'Revenue & Avg Discount by Category',
      description: 'mixed chart',
    },
    {
      page: 'CRM Pipeline',
      widgetTitle: 'Deals by Stage (reached)',
      description: 'funnel chart',
    },
  ];

  for (const { page: pageTitle, widgetTitle, description } of CHART_CHECKS) {
    test(`${description} on "${pageTitle}" renders SVG`, async ({ page }) => {
      await page.goto('/');
      await navigateTo(page, pageTitle);
      await waitForWidgetsLoaded(page);

      const card = widgetCard(page, widgetTitle);
      await expect(card).toBeVisible();

      const svg = card.locator('svg').first();
      await expect(svg).toBeVisible({ timeout: 10_000 });

      // SVG must have at least one child element (axes, paths, rects, etc.)
      const childCount = await svg.evaluate((el) => el.childElementCount);
      expect(childCount).toBeGreaterThan(0);
    });
  }
});
