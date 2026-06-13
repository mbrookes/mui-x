EBL-01: Currently orders have a currency symbol, but the currency is assumed to be consistent (for agregation, display in tables etc. Perhaps need a currency converted column. To be researched.)

**Researched — deferred.** The data already has `currency` per order (USD, EUR, GBP, etc.) and the calculated-fields system can define a `normalizedTotal = total * exchangeRate` expression field per source. To implement properly this would need: (1) an exchange-rates data source bundled with the demo, (2) a many-to-one relationship orders → exchange-rates (keyed by currency), and (3) a calculated column `expr-total-usd = total * rate`. The infrastructure is all in place but it's an exercise in data modelling rather than new platform features. Deferred until the exchange-rate data source is prepared.

EBL-02: Change the language selection in the example app settings dialog to a select.

EBL-03: CRM Pipeline page -> Deals by Stage widget: The funnel shows qualification as 105% of total. Prospecting is being considered the total, whereas it's only the number of deals in that stage. If we assume That any deal lower down the funnel was once in the stage above, should we roll up the totals? Or is there another better way of calculating/displaying the percentage? We probably still need to distingish between deals in stage and deals moved to the next stage. Consider best practice for this.

EBL-04: Related to EBL-03: Should we show where in each step a deal was lost? Would a waterfall chart be better? (I don't know.) Or a heatmap showing time in stage by some other category? (does one category perform better than another?) Or something else? Be creative.

EBL-05: Update the custom banner widget such that: 
- The banner is the entire widget, no title.
- The widget description makes it clear that it's a custom widget.
- The widget accepts a value field that determines its severity.
- That the value can be from some specific time range, so for example if some value exceeded a threshold in the last day.
- If possible, control whether the widget is displayed at all, based on some condidition.

EBL-06: CRM Contacts page > Total Contacts has a value, but th ewidget config doesn't show any fileds selected. Ensure that the data and widget config correctly reflects the dashboard state, and that all of example widgets can be created from scratch by the user. This may require changes to the x-studio package.
