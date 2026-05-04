export const CATEGORY_REVENUE_MULTIPLIERS: Record<string, number> = {
  Furniture: 1.4,
  Supplies: 3.5,
};

export function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}