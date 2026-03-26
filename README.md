# iwannasun-web

Static frontend for the iwannasun forecast experience. This repo owns the page shell, frontend orchestration, forecast normalization/derived state, rendering, theme behavior, and interaction/location controllers for the public web app.

## Frontend structure

- Page shell: [`index.html`](/Users/cmrsn/dev/iwannasun-web/index.html) loads the CSS and JS modules in order and provides the semantic DOM the app writes into.
- Orchestration: [`app.js`](/Users/cmrsn/dev/iwannasun-web/app.js) is the entrypoint. It wires modules together, owns app state, fetches forecast data, and decides when to render.
- Forecast model: [`forecast-model.js`](/Users/cmrsn/dev/iwannasun-web/forecast-model.js) normalizes API payloads, rows, timestamps, and day buckets.
- Selectors: [`forecast-selectors.js`](/Users/cmrsn/dev/iwannasun-web/forecast-selectors.js) derives view state from normalized data.
- Renderers: [`render/chart.js`](/Users/cmrsn/dev/iwannasun-web/render/chart.js) and [`render/timeline.js`](/Users/cmrsn/dev/iwannasun-web/render/timeline.js) own chart/timeline DOM output.
- Theme: [`theme/atmosphere.js`](/Users/cmrsn/dev/iwannasun-web/theme/atmosphere.js) computes and applies atmospheric CSS-variable state.
- Controllers: [`controllers/location.js`](/Users/cmrsn/dev/iwannasun-web/controllers/location.js) and [`controllers/interactions.js`](/Users/cmrsn/dev/iwannasun-web/controllers/interactions.js) own location/search/geolocation and interaction wiring.

## Docs

- [`docs/frontend-architecture.md`](/Users/cmrsn/dev/iwannasun-web/docs/frontend-architecture.md)
- [`docs/css-map.md`](/Users/cmrsn/dev/iwannasun-web/docs/css-map.md)

## Working rules

- Do not treat [`app.js`](/Users/cmrsn/dev/iwannasun-web/app.js) as a dumping ground. Keep it as orchestration and module wiring.
- Do not introduce a framework rewrite as part of normal editing.
- Prefer editing an existing boundary over creating random one-off utility files.
