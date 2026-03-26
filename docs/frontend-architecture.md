# Frontend Architecture

## What this repo is

`iwannasun-web` is a static browser frontend for the public iwannasun product. It renders the main forecast page, city landing pages, and the Solar API marketing/docs pages. The public forecast app is plain HTML/CSS/JS with explicit modules loaded from the page shell.

## Runtime flow

1. [`index.html`](/Users/cmrsn/dev/iwannasun-web/index.html) defines the DOM shell and loads styles plus JS modules in dependency order.
2. [`app.js`](/Users/cmrsn/dev/iwannasun-web/app.js) starts up, captures DOM references, owns page state, and wires the other modules together.
3. Forecast responses are normalized by [`forecast-model.js`](/Users/cmrsn/dev/iwannasun-web/forecast-model.js).
4. Derived UI state is computed through [`forecast-selectors.js`](/Users/cmrsn/dev/iwannasun-web/forecast-selectors.js).
5. [`app.js`](/Users/cmrsn/dev/iwannasun-web/app.js) delegates chart/timeline DOM work to [`render/chart.js`](/Users/cmrsn/dev/iwannasun-web/render/chart.js) and [`render/timeline.js`](/Users/cmrsn/dev/iwannasun-web/render/timeline.js).
6. Theme state is computed/applied by [`theme/atmosphere.js`](/Users/cmrsn/dev/iwannasun-web/theme/atmosphere.js).
7. Location/search/geolocation and interaction wiring are delegated to [`controllers/location.js`](/Users/cmrsn/dev/iwannasun-web/controllers/location.js) and [`controllers/interactions.js`](/Users/cmrsn/dev/iwannasun-web/controllers/interactions.js).

## Module map

- [`index.html`](/Users/cmrsn/dev/iwannasun-web/index.html): page shell and script/style load order.
- [`app.js`](/Users/cmrsn/dev/iwannasun-web/app.js): orchestration, fetch flow, app state, render scheduling, module wiring, and compatibility test surface.
- [`forecast-model.js`](/Users/cmrsn/dev/iwannasun-web/forecast-model.js): payload normalization, row normalization, day bucketing, timestamp helpers.
- [`forecast-selectors.js`](/Users/cmrsn/dev/iwannasun-web/forecast-selectors.js): pure-ish derived state for daylight windows, averages, timeline windows, chart row selection, and side-card state.
- [`render/chart.js`](/Users/cmrsn/dev/iwannasun-web/render/chart.js): chart axis calculation and chart canvas/axis rendering.
- [`render/timeline.js`](/Users/cmrsn/dev/iwannasun-web/render/timeline.js): timeline row rendering and timeline visibility/state output.
- [`theme/atmosphere.js`](/Users/cmrsn/dev/iwannasun-web/theme/atmosphere.js): atmospheric theme computation and CSS-variable application.
- [`controllers/location.js`](/Users/cmrsn/dev/iwannasun-web/controllers/location.js): city search, city suggestion interactions, preset location handling, geolocation, reverse geocoding.
- [`controllers/interactions.js`](/Users/cmrsn/dev/iwannasun-web/controllers/interactions.js): chart hover, pull-to-refresh, resize/time-sensitive UI refresh, and related event binding.
- [`styles/`](/Users/cmrsn/dev/iwannasun-web/styles): CSS ownership split by shell/theme/components. See [`docs/css-map.md`](/Users/cmrsn/dev/iwannasun-web/docs/css-map.md).

## Where to edit

- Forecast contract/model logic: [`forecast-model.js`](/Users/cmrsn/dev/iwannasun-web/forecast-model.js)
- Derived forecast/day/window logic: [`forecast-selectors.js`](/Users/cmrsn/dev/iwannasun-web/forecast-selectors.js)
- Chart rendering: [`render/chart.js`](/Users/cmrsn/dev/iwannasun-web/render/chart.js)
- Timeline rendering: [`render/timeline.js`](/Users/cmrsn/dev/iwannasun-web/render/timeline.js)
- Theme behavior / CSS variable application: [`theme/atmosphere.js`](/Users/cmrsn/dev/iwannasun-web/theme/atmosphere.js)
- Location/search/geolocation behavior: [`controllers/location.js`](/Users/cmrsn/dev/iwannasun-web/controllers/location.js)
- Interaction behavior: [`controllers/interactions.js`](/Users/cmrsn/dev/iwannasun-web/controllers/interactions.js)
- Shared orchestration / fetch flow / app-level state: [`app.js`](/Users/cmrsn/dev/iwannasun-web/app.js)
- CSS ownership: [`docs/css-map.md`](/Users/cmrsn/dev/iwannasun-web/docs/css-map.md)

## Non-goals / constraints

- No framework rewrite. This app is intentionally plain JS.
- [`app.js`](/Users/cmrsn/dev/iwannasun-web/app.js) should stay the orchestration layer, not absorb model/render/controller internals again.
- Avoid creating random utility files for one or two helpers. Put logic in the most local existing module that owns it.
- Keep forecast-model responsibilities out of render/theme/controller modules.
- Keep controller modules focused on event and UI coordination, not DOM rendering internals.
