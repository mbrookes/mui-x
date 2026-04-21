import type { StudioDataSource } from '../../../../packages/x-studio/src';

export const SALES_SOURCE_ID = 'source-sales';

export const salesSource: StudioDataSource = {
  id: SALES_SOURCE_ID,
  label: 'Sales',
  fields: [
    { id: 'product', label: 'Product', type: 'string' },
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'region', label: 'Region', type: 'string' },
    { id: 'revenue', label: 'Revenue', type: 'number' },
    { id: 'quantity', label: 'Quantity', type: 'number' },
    { id: 'margin', label: 'Margin %', type: 'number' },
  ],
  rows: [
    { id: 1, product: 'Alpha Pro', category: 'Software', region: 'DACH', revenue: 12400, quantity: 8, margin: 62 },
    { id: 2, product: 'Beta Suite', category: 'Hardware', region: 'UK', revenue: 9750, quantity: 5, margin: 38 },
    { id: 3, product: 'Gamma Cloud', category: 'Software', region: 'Nordics', revenue: 18200, quantity: 12, margin: 71 },
    { id: 4, product: 'Delta Device', category: 'Hardware', region: 'DACH', revenue: 6300, quantity: 3, margin: 22 },
    { id: 5, product: 'Epsilon Analytics', category: 'Software', region: 'UK', revenue: 21500, quantity: 15, margin: 68 },
    { id: 6, product: 'Zeta Connect', category: 'Services', region: 'Nordics', revenue: 7800, quantity: 6, margin: 45 },
    { id: 7, product: 'Eta Platform', category: 'Software', region: 'DACH', revenue: 16900, quantity: 11, margin: 74 },
    { id: 8, product: 'Theta Hub', category: 'Hardware', region: 'UK', revenue: 4200, quantity: 2, margin: 18 },
    { id: 9, product: 'Iota Insights', category: 'Services', region: 'DACH', revenue: 9100, quantity: 7, margin: 53 },
    { id: 10, product: 'Kappa Flow', category: 'Software', region: 'Nordics', revenue: 14600, quantity: 9, margin: 66 },
  ],
};

export const salesBindings = salesSource.fields.map((f) => ({ field: f.id, label: f.label }));
