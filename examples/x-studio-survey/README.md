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
# Client (Vite dev server)
pnpm --filter x-studio-survey-example dev

# Backend (AI + MCP) — seeds the survey SQLite DB from the Excel files
pnpm --filter x-studio-survey-example server
```

## Backend endpoints

The server (`src/server/index.ts`) loads both workbooks into an in-memory SQLite
database and exposes:

- `GET /health` — readiness + seeded table row counts
- `POST /api/ai/chat` (and `/title`, `/widget`, `/approval`) — x-studio AI chat
- `POST|GET|DELETE /api/mcp` — a Streamable-HTTP **Model Context Protocol**
  server

The MCP server exposes the x-studio dashboard tools plus `query_data_source`,
which runs structured (columns / filters / aggregations / order / paging)
read-only queries against the seeded survey tables. Point an MCP client at it;
for stdio-only clients (e.g. Claude Desktop) bridge with `mcp-remote`:

```json
{
  "mcpServers": {
    "x-studio-survey": {
      "command": "npx",
      "args": ["mcp-remote", "https://survey-dev.up.railway.app/api/mcp"]
    }
  }
}
```

## Report status / next steps

The report in `src/config/surveyReport.ts` is a **data-driven reconstruction**
of the published 2025 survey report (https://mui-2025-survey-report.vercel.app/).
It charts the same questions from the same spreadsheet data, but the section
text, chart selection, and typeface were **not** yet aligned 1:1 with the
original — that page was unreachable from the build environment's network
allowlist when this was authored.

To finish the exact-match pass (e.g. in a session that can reach the report):

1. Fetch the original report and note each section's heading + verbatim body
   text, every chart (type + which question), and the font family.
2. Update the section text and chart configs in `src/config/surveyReport.ts`
   (the `FIELDS` map in `src/surveyData.ts` lists the available 2025 columns).
3. Match the typeface in `src/theme.ts` (`typography.fontFamily`) and the text
   widget font sizes.

## Using the adapter with your own spreadsheet

```ts
import { loadExcelWorkbook } from './connectors/excelAdapter';

const { sources, adapter } = await loadExcelWorkbook('/path/to/file.xlsx', {
  idPrefix: 'my-workbook',
  labelPrefix: 'My data',
});
// `sources` → one StudioDataSource per sheet; `adapter` serves them all.
```
