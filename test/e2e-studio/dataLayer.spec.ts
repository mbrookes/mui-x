/**
 * End-to-end tests for x-studio against a running MUI data layer.
 *
 * Skipped unless DATA_LAYER_E2E=1. The app needs STUDIO_DATA_LAYER_URL and DATA_LAYER_API_KEY,
 * and the data layer needs the Petstore entities `pets` and `pet`, readable by the key's owner.
 * See examples/x-studio/README.md.
 */

import { test, expect, type Page } from '@playwright/test';

test.skip(!process.env.DATA_LAYER_E2E, 'Set DATA_LAYER_E2E=1 to run against a data layer.');

// A cold dev server load fetches about 2,800 unbundled modules before any widget renders.
const LOAD_TIMEOUT = 120_000;
test.describe.configure({ timeout: 3 * LOAD_TIMEOUT });

function widgetCard(page: Page, widgetTitle: string) {
  return page.locator(`[data-widget-card][aria-label="Widget: ${widgetTitle}"]`);
}

/** The ?fv= value that sets one filter, in the format App.tsx decodes. */
function filterValues(values: Record<string, { operator: string; value: unknown }>) {
  return Buffer.from(JSON.stringify(values)).toString('base64');
}

test.describe('Data layer mode', () => {
  test('lists the entities and shows their rows', async ({ page }) => {
    await page.goto('/?mode=data-layer');

    const pets = widgetCard(page, 'Pets');
    await expect(pets.getByRole('gridcell', { name: 'available' }).first()).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await expect(pets.getByRole('columnheader', { name: 'status' })).toBeVisible();
    // The data drawer lists the same entities.
    await expect(page.getByText('Pets', { exact: true }).first()).toBeVisible();
  });

  test('shows the error envelope when a required filter is missing', async ({ page }) => {
    await page.goto('/?mode=data-layer');

    await expect(widgetCard(page, 'Pet')).toContainText(
      'VALIDATION_ERROR: Add an eq filter on "id"',
      { timeout: LOAD_TIMEOUT },
    );
  });

  test('reads one record through the required filter', async ({ page, request }) => {
    const response = await request.post('/data-layer/api/v1/query', {
      data: { queries: [{ id: 'first', entity: 'pets', select: ['id'], limit: 1 }] },
    });
    expect(response.ok()).toBe(true);
    const { results } = (await response.json()) as { results: { data: { id: number }[] }[] };
    const petId = results[0].data[0].id;

    const fv = filterValues({ 'filter-dl-pet-id': { operator: 'equals', value: petId } });
    await page.goto(`/?mode=data-layer&fv=${encodeURIComponent(fv)}`);

    const pet = widgetCard(page, 'Pet');
    await expect(pet.getByRole('row')).toHaveCount(2, { timeout: LOAD_TIMEOUT });
    await expect(pet).not.toContainText('VALIDATION_ERROR');
  });
});
