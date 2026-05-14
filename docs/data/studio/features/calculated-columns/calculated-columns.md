---
title: Studio - Calculated columns
productId: x-studio
packageName: '@mui/x-studio'
githubLabel: 'scope: studio'
---

# Studio - Calculated columns

<p class="description">Add computed per-row fields to any data source using the expression system — without modifying your source data.</p>

{{"component": "@mui/internal-core-docs/ComponentLinkHeader"}}

## What is a calculated column?

A calculated column is a `StudioExpressionField` with `isMeasure: false`. It computes a scalar value for **each individual row** using an expression tree. The result is appended to the row as a virtual field — it can be used anywhere a physical field can: as a chart axis, a KPI value, a grid column, a filter operand, and so on.

## StudioExpressionField

```ts
interface StudioExpressionField {
  id: string;
  label: string;
  description?: string;
  sourceId: string;           // which data source owns these rows
  isMeasure: false;           // calculated column (per-row)
  expression: StudioExpression;
  type?: 'string' | 'number' | 'date' | 'datetime' | 'boolean'; // inferred if omitted
  format?: StudioNumberFormat;
  currencyCode?: string;
  hidden?: boolean;
}
```

## Expression types

An expression is one of four node types that compose into a tree.

### Field reference (`StudioFieldExpression`)

Returns the value of a field on the current row:

```ts
{ id: 'revenue' }
```

### Literal value (`StudioValueExpression`)

Returns a constant:

```ts
{ type: 'number', value: 0.2 }   // 20% rate
{ type: 'string', value: 'USD' }
{ type: 'boolean', value: true }
```

### Arithmetic / logic (`StudioFunctionExpression`)

Applies an operator to one or more sub-expressions:

```ts
{
  operator: 'multiply',
  args: [{ id: 'quantity' }, { id: 'unitPrice' }],
}
```

| Operator | Arity | Description |
| :--- | :--- | :--- |
| `add` | 2 | `a + b` |
| `subtract` | 2 | `a - b` |
| `multiply` | 2 | `a * b` |
| `divide` | 2 | `a / b` (returns `null` for divide-by-zero) |
| `negate` | 1 | `-a` |
| `abs` | 1 | Absolute value |
| `round` | 1 | Round to nearest integer |
| `floor` | 1 | Floor |
| `ceil` | 1 | Ceiling |
| `equals` | 2 | `a === b` → boolean |
| `not_equals` | 2 | `a !== b` → boolean |
| `greater_than` | 2 | `a > b` → boolean |
| `less_than` | 2 | `a < b` → boolean |
| `greater_than_or_equal` | 2 | `a >= b` → boolean |
| `less_than_or_equal` | 2 | `a <= b` → boolean |
| `and` | 2 | Logical AND |
| `or` | 2 | Logical OR |
| `not` | 1 | Logical NOT |
| `if` | 3 | `if condition then a else b` |
| `coalesce` | 2 | Returns `a` if not null/undefined, otherwise `b` |
| `concat` | 2 | String concatenation |
| `lower` | 1 | Lowercase string |
| `upper` | 1 | Uppercase string |
| `trim` | 1 | Trim whitespace |
| `length` | 1 | String length |
| `year` | 1 | Year component of a date |
| `month` | 1 | Month component of a date (1–12) |
| `day` | 1 | Day of month (1–31) |
| `date_diff_days` | 2 | Difference in days between two dates |
| `sum` | 1 | Measure: sum of field across all (filtered) rows |
| `avg` | 1 | Measure: average |
| `count` | 1 | Measure: count of non-null values |
| `min` | 1 | Measure: minimum |
| `max` | 1 | Measure: maximum |

### Join field (`StudioJoinFieldExpression`)

Looks up a field on a related source via a declared [relationship](/x/react-studio/data/relationships):

```ts
{
  joinSourceId: 'customers', // related source
  fieldId: 'region',         // field on that source
}
```

Studio resolves the join key automatically using the `StudioRelationship` where `sourceId` matches the expression field's `sourceId`.

## Examples

### Gross profit margin

```ts
{
  id: 'gross-margin',
  label: 'Gross Margin %',
  sourceId: 'orders',
  isMeasure: false,
  type: 'number',
  format: 'percent',
  expression: {
    operator: 'divide',
    args: [
      {
        operator: 'subtract',
        args: [{ id: 'revenue' }, { id: 'cost' }],
      },
      { id: 'revenue' },
    ],
  },
}
```

### Customer segment label (if/else)

```ts
{
  id: 'segment',
  label: 'Segment',
  sourceId: 'customers',
  isMeasure: false,
  type: 'string',
  expression: {
    operator: 'if',
    args: [
      { operator: 'greater_than', args: [{ id: 'ltv' }, { type: 'number', value: 10000 }] },
      { type: 'string', value: 'High Value' },
      { type: 'string', value: 'Standard' },
    ],
  },
}
```

### Denormalised country from a related source

```ts
{
  id: 'customer-country',
  label: 'Customer Country',
  sourceId: 'orders',   // expression lives on orders
  isMeasure: false,
  type: 'string',
  expression: {
    joinSourceId: 'customers', // but pulls from customers.country
    fieldId: 'country',
  },
}
```

## Preloading expression fields

Pass calculated columns as part of `initialState`:

```tsx
const initialState = createDefaultStudioState({
  expressionFields: [grossMargin, customerCountry],
});
```

They appear alongside physical fields in every picker (chart axis, KPI value, grid column) for the matching source.
