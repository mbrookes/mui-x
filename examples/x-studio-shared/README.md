# x-studio-shared

The demo data and dashboard definitions every other x-studio example is built on. This is a library, not an app — there is nothing to run here.

## Why it exists

The browser apps and the dev server have to agree on their data down to the row. Both call the same generators with the same seed (`{ seed: 42 }`), so the rows SQLite is seeded with are the rows the client would have generated for itself. That is what makes it possible to switch an app between memory mode and server mode and see the same numbers.

## The two entry points

| Import                   | Safe to load from | Contents                                                                                             |
| ------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `x-studio-shared`        | The browser       | Everything below, plus `FeatureFlagSettings` (a React component) and the office-supplies demo state. |
| `x-studio-shared/server` | Node              | The sales and CRM generators, their source IDs, and `INITIAL_STATE`.                                 |

The split is not cosmetic. The default barrel pulls in React and `@mui/material`, which a Node process cannot resolve — importing it from the dev server crashes the server at startup. Anything the dev server needs belongs in `server.ts`; keep React out of it.

## What is in here

- `src/salesData/` — the sales generator (customers, products, orders, order items, shipments, shipment items) and the monthly exchange-rate table the currency expression fields join against.
- `src/crmData/` — contacts, deals, activities and deal-stage transitions, used to demonstrate cross-source relationships.
- `src/officeSuppliesData/` and `src/config/` — the dashboard definitions: pages, widgets, relationships and expression fields, exported as `INITIAL_STATE` and `OS_INITIAL_STATE`.
- `src/prng.ts` — the seeded generator that makes all of the above deterministic.

## Consumers

[`x-studio`](../x-studio), [`x-studio-ai`](../x-studio-ai), [`x-studio-composed`](../x-studio-composed) and [`x-studio-ag`](../x-studio-ag) import the browser barrel. [`x-studio-dev-server`](../x-studio-dev-server) imports `x-studio-shared/server`.

## Changing the data

Adding a field to a generator changes what the dev server inserts, so its tables have to change with it — see the schema notes in the [dev server README](../x-studio-dev-server/README.md#database). The server detects that drift on startup and rebuilds its tables, but the column has to exist in `src/db/schema.ts` first.

```bash
pnpm typescript    # the only script here
```
