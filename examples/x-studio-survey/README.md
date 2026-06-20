# x-studio survey example

A copy of the `x-studio` example app wired to a **custom, generic Excel
(`.xlsx`) data adapter**, used to build the MUI Developer Survey report.

## What's different from `examples/x-studio`

- **`src/connectors/excelAdapter.ts`** — a schema-agnostic adapter that reads
  any spreadsheet:
  - every **sheet (tab)** in a workbook becomes a **separate** `StudioDataSource`;
  - all sheets of a workbook are served by the **same** adapter instance;
  - column names, field types (`string` / `number` / `boolean` / `date` /
    `datetime`) and distinct values are inferred from the sheet contents, so it
    is not tied to the survey schema. Blank and duplicate headers get safe
    fallback ids so no column is dropped.
- **`src/surveyData.ts`** — loads the two bundled workbooks
  (`public/data/survey2025.xlsx`, `public/data/survey2023.xlsx`; paths are
  hardcoded) through the adapter and exposes them as data sources.
- **`src/config/surveyReport.ts`** — the survey report itself: pages and widgets
  that chart the raw responses (every chart uses a `count` aggregation, one
  bar/slice per answer).
- **`src/App.tsx`** — trimmed to load the survey workbooks, register the Excel
  adapter for every sheet, and render the report. The original sales/CRM demo
  pages are removed.

## Data sources produced

| Workbook | Sheet → data source |
| --- | --- |
| `survey2025.xlsx` | `Sheet1` (2,057 responses), `Groups` |
| `survey2023.xlsx` | `Data`, `Answers per day`, `Product representation`, `Groups` |

## Running

```bash
pnpm --filter x-studio-survey-example dev
```

## Using the adapter with your own spreadsheet

```ts
import { loadExcelWorkbook } from './connectors/excelAdapter';

const { sources, adapter } = await loadExcelWorkbook('/path/to/file.xlsx', {
  idPrefix: 'my-workbook',
  labelPrefix: 'My data',
});
// `sources` → one StudioDataSource per sheet; `adapter` serves them all.
```
