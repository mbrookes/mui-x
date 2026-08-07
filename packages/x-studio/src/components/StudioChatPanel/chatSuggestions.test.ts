import { describe, expect, it } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import type { StudioDataSource, StudioWidget } from '../../models';
import { generateSuggestions } from './chatSuggestions';

const ordersSource: StudioDataSource = {
  id: 'orders',
  label: 'Orders',
  fields: [
    { id: 'revenue', label: 'Revenue', type: 'number' },
    { id: 'region', label: 'Region', type: 'string' },
  ],
  rows: [],
};

// A locale override for just the tokens under test — mirrors how a real translated
// bundle (fr/de/es/ptBR) only needs to differ from the English default in the tokens
// that matter to a given assertion.
const frLikeLocaleText = {
  ...DEFAULT_STUDIO_LOCALE_TEXT,
  aiSuggestionBarChart: (numericLabel: string, catLabel: string) =>
    `Graphique à barres : ${numericLabel} par ${catLabel}`,
  aiSuggestionBarChartPrompt: (numericLabel: string, catLabel: string, sourceLabel: string) =>
    `Ajoute un graphique à barres montrant ${numericLabel} par ${catLabel} à partir des données ${sourceLabel}.`,
  aiSuggestionAddPage: 'Ajouter une nouvelle page',
  aiSuggestionAddPagePrompt: 'Crée une nouvelle page de tableau de bord.',
};

describe('generateSuggestions', () => {
  // Regression coverage for finding 3.14: the submitted `value` (which appears in the
  // chat thread as the user's own message) was hardcoded English even when `label` (the
  // chip's displayed text) was already localized — so a French user clicking a
  // French-labeled chip would see their own message render in English. `value` must now
  // track the active locale the same way `label` does.
  it('localizes both the suggestion label and its submitted value for the empty-state bar-chart suggestion', () => {
    const suggestions = generateSuggestions({ orders: ordersSource }, {}, [], frLikeLocaleText);
    const barChartSuggestion = suggestions.find((s) => s.label.startsWith('Graphique à barres'));
    expect(barChartSuggestion).toBeDefined();
    expect(barChartSuggestion!.value).toBe(
      'Ajoute un graphique à barres montrant Revenue par Region à partir des données Orders.',
    );
    // Must not silently fall back to the English literal.
    expect(barChartSuggestion!.value).not.toMatch(/^Add a bar chart/);
  });

  it('localizes both the label and value for the "add page" suggestion when widgets already exist', () => {
    const widget: StudioWidget = {
      id: 'w1',
      kind: 'kpi',
      title: 'Revenue',
      sourceId: 'orders',
      config: {},
    } as unknown as StudioWidget;
    const suggestions = generateSuggestions(
      { orders: ordersSource },
      { w1: widget },
      ['w1'],
      frLikeLocaleText,
    );
    const addPageSuggestion = suggestions.find((s) => s.label === 'Ajouter une nouvelle page');
    expect(addPageSuggestion).toBeDefined();
    expect(addPageSuggestion!.value).toBe('Crée une nouvelle page de tableau de bord.');
  });

  it('uses the English default value when no locale override is provided (back-compat)', () => {
    const suggestions = generateSuggestions(
      { orders: ordersSource },
      {},
      [],
      DEFAULT_STUDIO_LOCALE_TEXT,
    );
    const barChartSuggestion = suggestions.find((s) => s.label.startsWith('Bar chart'));
    expect(barChartSuggestion).toBeDefined();
    expect(barChartSuggestion!.value).toBe(
      'Add a bar chart showing Revenue by Region from the Orders data.',
    );
  });

  // Regression coverage for finding 3.24: hidden data sources are excluded from the
  // AI's payload everywhere else (`createWidgetFromDescription.ts`, `richContext.ts`),
  // so suggestions must not steer users toward asking about a source the host
  // deliberately hid — the model's schema payload excludes it, so it couldn't act on
  // the request anyway.
  describe('hidden data sources', () => {
    const hiddenSource: StudioDataSource = {
      id: 'internal',
      label: 'Internal',
      hidden: true,
      fields: [
        { id: 'secretAmount', label: 'Secret Amount', type: 'number' },
        { id: 'secretDate', label: 'Secret Date', type: 'date' },
      ],
      rows: [],
    };

    it('excludes hidden sources from empty-state suggestions', () => {
      const suggestions = generateSuggestions(
        { internal: hiddenSource },
        {},
        [],
        DEFAULT_STUDIO_LOCALE_TEXT,
      );
      // No suggestion should reference the hidden source's label or fields.
      for (const suggestion of suggestions) {
        expect(suggestion.label).not.toContain('Internal');
        expect(suggestion.value).not.toContain('Internal');
        expect(suggestion.value).not.toContain('Secret');
      }
    });

    it('still generates suggestions from a visible source when a hidden source is also present', () => {
      const suggestions = generateSuggestions(
        { orders: ordersSource, internal: hiddenSource },
        {},
        [],
        DEFAULT_STUDIO_LOCALE_TEXT,
      );
      const barChartSuggestion = suggestions.find((s) => s.label.startsWith('Bar chart'));
      expect(barChartSuggestion).toBeDefined();
      expect(barChartSuggestion!.value).toContain('Orders');
    });

    it('does not suggest a date filter when the only field of type date/datetime lives on a hidden source', () => {
      const widget: StudioWidget = {
        id: 'w1',
        kind: 'kpi',
        title: 'Revenue',
        sourceId: 'orders',
        config: {},
      } as unknown as StudioWidget;
      const suggestions = generateSuggestions(
        { orders: ordersSource, internal: hiddenSource },
        { w1: widget },
        ['w1'],
        DEFAULT_STUDIO_LOCALE_TEXT,
      );
      const dateFilterSuggestion = suggestions.find(
        (s) => s.label === DEFAULT_STUDIO_LOCALE_TEXT.aiSuggestionAddDateFilter,
      );
      expect(dateFilterSuggestion).toBeUndefined();
    });
  });
});
