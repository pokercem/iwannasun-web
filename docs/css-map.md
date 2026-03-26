# CSS Map

## Ownership

- [`styles/base.css`](/Users/cmrsn/dev/iwannasun-web/styles/base.css): reset, tokens, page shell, layout, shared cards, generic controls, shared typography, footer.
- [`styles/theme-atmosphere.css`](/Users/cmrsn/dev/iwannasun-web/styles/theme-atmosphere.css): atmospheric skin and theme-specific visual overrides via CSS variables.
- [`styles/components-forecast.css`](/Users/cmrsn/dev/iwannasun-web/styles/components-forecast.css): decision block, KPI cards, next-window card, notes/about content, timeline rows, loading/error states, pull-to-refresh indicator.
- [`styles/components-location.css`](/Users/cmrsn/dev/iwannasun-web/styles/components-location.css): city input, clear button, suggestion dropdown, location-control responsive behavior.
- [`styles/components-chart.css`](/Users/cmrsn/dev/iwannasun-web/styles/components-chart.css): chart block, canvas, x/y axes, chart sizing.
- [`styles/solar.css`](/Users/cmrsn/dev/iwannasun-web/styles/solar.css): Solar API pages only. Keep separate from the forecast app CSS.

## Quick edit guide

- Need to change page shell spacing or generic button/input styling: [`styles/base.css`](/Users/cmrsn/dev/iwannasun-web/styles/base.css)
- Need to change atmosphere/background/card skin behavior: [`styles/theme-atmosphere.css`](/Users/cmrsn/dev/iwannasun-web/styles/theme-atmosphere.css)
- Need to change timeline, decision text, KPI, side-card, or loading/error styling: [`styles/components-forecast.css`](/Users/cmrsn/dev/iwannasun-web/styles/components-forecast.css)
- Need to change search input or suggestions dropdown styling: [`styles/components-location.css`](/Users/cmrsn/dev/iwannasun-web/styles/components-location.css)
- Need to change chart canvas or axes styling: [`styles/components-chart.css`](/Users/cmrsn/dev/iwannasun-web/styles/components-chart.css)

## Guardrails

- Prefer the most local stylesheet that clearly owns the surface.
- Do not move Solar API styling into the forecast app CSS.
- Do not recreate a monolithic app stylesheet unless there is a clear structural reason.
