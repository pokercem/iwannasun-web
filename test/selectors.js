'use strict';

(function runSelectorRegressionSuite() {
  const api = window.IWS_SELECTOR_TEST_API;
  const resultsEl = document.getElementById('results');
  const summaryStatusEl = document.getElementById('summaryStatus');
  const summaryMetaEl = document.getElementById('summaryMeta');

  if (!api) {
    summaryStatusEl.textContent = 'Failed';
    summaryStatusEl.className = 'status fail';
    summaryMetaEl.textContent = 'Selector test API was not exposed by app.js.';
    return;
  }

  const tests = [];
  const els = {
    daySelect: document.getElementById('daySelect'),
    timePill: document.getElementById('timePill'),
    decisionText: document.getElementById('decisionText'),
    decisionContext: document.getElementById('decisionContext'),
    nextWindow: document.getElementById('nextWindow'),
    nextWindowSub: document.getElementById('nextWindowSub'),
    sunriseTime: document.getElementById('sunriseTime'),
    sunsetTime: document.getElementById('sunsetTime'),
    timeline: document.getElementById('timeline'),
    modelModeNote: document.getElementById('modelModeNote'),
    xAxis: document.getElementById('xAxis'),
    yAxis: document.getElementById('yAxis'),
    canvas: document.getElementById('sunChart'),
  };

  if (els.canvas) {
    els.canvas.getBoundingClientRect = () => ({
      width: 320,
      height: 160,
      left: 0,
      top: 0,
      right: 320,
      bottom: 160,
    });
  }

  function test(name, fn) {
    tests.push({ name, fn });
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
    }
  }

  function assertNotEqual(actual, expected, message) {
    if (actual === expected) {
      throw new Error(`${message} Did not expect ${JSON.stringify(expected)}.`);
    }
  }

  function assertApprox(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) > tolerance) {
      throw new Error(`${message} Expected ${expected} +/- ${tolerance}, got ${actual}.`);
    }
  }

  function assertThrows(fn, pattern, message) {
    let thrown = null;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    if (!thrown) throw new Error(`${message} Expected function to throw.`);
    const detail = thrown && thrown.message ? thrown.message : String(thrown);
    if (pattern && !pattern.test(detail)) {
      throw new Error(`${message} Expected error matching ${pattern}, got ${detail}.`);
    }
  }

  function withTimezone(tzName, fn) {
    api.setSelectorTestTimezone(tzName);
    try {
      return fn();
    } finally {
      api.setSelectorTestTimezone('');
    }
  }

  function withFixedNow(nowMs, fn) {
    const originalNow = Date.now;
    Date.now = () => nowMs;
    try {
      return fn();
    } finally {
      Date.now = originalNow;
    }
  }

  function row({
    timeUtc,
    dayIndex = 0,
    score = 0,
    confidence = 0.5,
    elevation = 10,
    isDaylight = elevation > 0,
    low = 0,
    mid = 0,
    high = 0,
    precip = 0,
    azimuth = 180,
  }) {
    return {
      time_utc: timeUtc,
      time_local: timeUtc,
      day_index: dayIndex,
      sun_score: score,
      confidence,
      elevation,
      azimuth,
      is_daylight: isDaylight,
      cloud: {
        low,
        mid,
        high,
        precip_mm: precip,
      },
    };
  }

  function windowIso(start, end, minutes) {
    return { start, end, minutes };
  }

  function toMs(isoUtc) {
    return new Date(isoUtc).getTime();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function renderFixtureData() {
    const days = {
      0: [
        row({ timeUtc: '2026-06-01T09:50:00Z', score: 20, confidence: 0.4, elevation: 2 }),
        row({ timeUtc: '2026-06-01T10:00:00Z', score: 66, confidence: 0.6, elevation: 12 }),
        row({ timeUtc: '2026-06-01T10:10:00Z', score: 72, confidence: 0.65, elevation: 18 }),
        row({ timeUtc: '2026-06-01T10:20:00Z', score: 78, confidence: 0.68, elevation: 20 }),
        row({ timeUtc: '2026-06-01T10:30:00Z', score: 30, confidence: 0.4, elevation: 16 }),
        row({ timeUtc: '2026-06-01T10:40:00Z', score: 0, confidence: 0.25, elevation: -1, isDaylight: false }),
      ],
      1: [
        row({ timeUtc: '2026-06-02T10:00:00Z', dayIndex: 1, score: 52, confidence: 0.45, elevation: 4 }),
        row({ timeUtc: '2026-06-02T12:00:00Z', dayIndex: 1, score: 65, confidence: 0.72, elevation: 28 }),
        row({ timeUtc: '2026-06-02T12:10:00Z', dayIndex: 1, score: 80, confidence: 0.78, elevation: 30 }),
        row({ timeUtc: '2026-06-02T12:20:00Z', dayIndex: 1, score: 68, confidence: 0.7, elevation: 27 }),
        row({ timeUtc: '2026-06-02T14:00:00Z', dayIndex: 1, score: 62, confidence: 0.6, elevation: 20 }),
      ],
    };

    return {
      data: {
        meta: { tz_name: 'UTC', interval_minutes: 10 },
      },
      days,
    };
  }

  function renderSnapshotAt({ dayIndex = 0, nowMs, tzName = 'UTC', fixture = null }) {
    const base = fixture || renderFixtureData();
    return withTimezone(tzName, () => {
      const renderState = api.deriveForecastRenderState({
        data: base.data,
        days: base.days,
        dayIndex,
        nowMs,
      });
      return {
        renderState,
        snapshot: api.buildRenderSnapshot(renderState, nowMs),
      };
    });
  }

  function resetRenderRig() {
    api.resetSelectorTestRenderState();
    api.setSelectorTestAppState({ data: null, days: null, tzName: '', dayIndex: 0, isBusy: false });
    if (els.daySelect) els.daySelect.value = '0';
    if (els.timePill) {
      els.timePill.textContent = '';
      els.timePill.title = '';
    }
    if (els.decisionText) els.decisionText.textContent = '';
    if (els.decisionContext) els.decisionContext.textContent = '';
    if (els.nextWindow) els.nextWindow.textContent = '';
    if (els.nextWindowSub) els.nextWindowSub.textContent = '';
    if (els.sunriseTime) els.sunriseTime.textContent = '';
    if (els.sunsetTime) els.sunsetTime.textContent = '';
    if (els.timeline) els.timeline.innerHTML = '';
    if (els.modelModeNote) els.modelModeNote.textContent = '';
    if (els.xAxis) els.xAxis.innerHTML = '';
    if (els.yAxis) els.yAxis.innerHTML = '';
  }

  test('Today decision uses the nearest current daylight row', () => {
    const rows = [
      row({ timeUtc: '2026-06-01T09:40:00Z', score: 18, confidence: 0.35, elevation: 6 }),
      row({ timeUtc: '2026-06-01T10:10:00Z', score: 82, confidence: 0.91, elevation: 24 }),
      row({ timeUtc: '2026-06-01T10:50:00Z', score: 58, confidence: 0.62, elevation: 28 }),
    ];
    const state = withTimezone('UTC', () => api.selectDecisionViewState(0, rows, 28, toMs('2026-06-01T10:12:00Z')));
    assertEqual(state.source, 'today_now', 'Today decision source should stay on the live row.');
    assertEqual(state.contextLabel, 'now', 'Today decision context should remain "now".');
    assertEqual(state.decisionRow.time_utc, '2026-06-01T10:10:00Z', 'Nearest row should be selected.');
    assertEqual(state.themeRow.time_utc, '2026-06-01T10:10:00Z', 'Theme row should track the live decision row.');
    assertEqual(state.score, 82, 'Today score should come from the selected row.');
    assertEqual(state.confidence, 0.91, 'Today confidence should come from the selected row.');
  });

  test('Today below-horizon selection still uses the nearest row', () => {
    const rows = [
      row({ timeUtc: '2026-06-01T05:50:00Z', score: 0, confidence: 0.22, elevation: -6, isDaylight: false }),
      row({ timeUtc: '2026-06-01T06:20:00Z', score: 24, confidence: 0.48, elevation: 3 }),
    ];
    const state = withTimezone('UTC', () => api.selectDecisionViewState(0, rows, 3, toMs('2026-06-01T05:52:00Z')));
    assertEqual(state.source, 'today_now', 'Below-horizon today should still use the live-row path.');
    assertEqual(state.decisionRow.time_utc, '2026-06-01T05:50:00Z', 'Nearest night row should remain selected.');
    assert(state.decisionRow.elevation < 0, 'Selected row should preserve below-horizon elevation.');
    assertEqual(state.themeRow.time_utc, '2026-06-01T05:50:00Z', 'Theme row should match the selected row.');
  });

  test('Tomorrow decision uses a synthetic daylight-average row anchored to forecast-local noon', () => {
    const rows = [
      row({ timeUtc: '2026-01-15T17:00:00Z', dayIndex: 1, score: 40, confidence: 0.4, elevation: 15, low: 10 }),
      row({ timeUtc: '2026-01-15T20:00:00Z', dayIndex: 1, score: 80, confidence: 0.6, elevation: 30, low: 20 }),
      row({ timeUtc: '2026-01-15T23:00:00Z', dayIndex: 1, score: 20, confidence: 0.8, elevation: 12, low: 30 }),
    ];
    const state = withTimezone('America/Los_Angeles', () => api.selectDecisionViewState(1, rows, 30));
    assertEqual(state.source, 'tomorrow_daylight_average', 'Tomorrow should use the daylight-average path when daylight exists.');
    assertEqual(state.contextLabel, 'tomorrow (daylight average)', 'Tomorrow context label should remain unchanged.');
    assert(state.decisionRow && state.decisionRow._themeFallback === true, 'Synthetic tomorrow row should keep the theme fallback marker.');
    assertEqual(state.decisionRow.time_utc, '2026-01-15T20:00:00Z', 'Tomorrow anchor should be forecast-local noon, not viewer-local noon.');
    assertApprox(state.score, (40 + 80 + 20) / 3, 1e-9, 'Synthetic tomorrow score should average daylight rows.');
    assertApprox(state.confidence, (0.4 + 0.6 + 0.8) / 3, 1e-9, 'Synthetic tomorrow confidence should average daylight rows.');
  });

  test('Tomorrow no-daylight fallback uses the nearest forecast-local noon row', () => {
    const rows = [
      row({ timeUtc: '2026-12-01T10:00:00Z', dayIndex: 1, score: 11, confidence: 0.2, elevation: -4, isDaylight: false }),
      row({ timeUtc: '2026-12-01T12:00:00Z', dayIndex: 1, score: 22, confidence: 0.3, elevation: -2, isDaylight: false }),
      row({ timeUtc: '2026-12-01T14:00:00Z', dayIndex: 1, score: 33, confidence: 0.4, elevation: -5, isDaylight: false }),
    ];
    const state = withTimezone('UTC', () => api.selectDecisionViewState(1, rows, -2));
    assertEqual(state.source, 'tomorrow_no_daylight', 'Tomorrow should fall back when no daylight rows exist.');
    assert(state.decisionRow && state.decisionRow._themeFallback === true, 'No-daylight tomorrow fallback should keep theme fallback marker.');
    assertEqual(state.decisionRow.time_utc, '2026-12-01T12:00:00Z', 'No-daylight fallback should still anchor to local noon.');
    assertEqual(state.score, 22, 'Fallback score should come from the selected noon row.');
  });

  test('Side-card selects the active today window when now is inside it', () => {
    const rows = [
      row({ timeUtc: '2026-06-01T10:00:00Z', score: 65, confidence: 0.6, elevation: 12 }),
      row({ timeUtc: '2026-06-01T10:10:00Z', score: 72, confidence: 0.65, elevation: 18 }),
      row({ timeUtc: '2026-06-01T10:20:00Z', score: 78, confidence: 0.68, elevation: 20 }),
      row({ timeUtc: '2026-06-01T10:30:00Z', score: 30, confidence: 0.4, elevation: 16 }),
    ];
    const tomorrowRows = [
      row({ timeUtc: '2026-06-02T11:00:00Z', dayIndex: 1, score: 65, confidence: 0.6, elevation: 18 }),
      row({ timeUtc: '2026-06-02T11:10:00Z', dayIndex: 1, score: 74, confidence: 0.68, elevation: 24 }),
    ];
    const state = api.selectSideCardViewState(0, rows, { 1: tomorrowRows }, toMs('2026-06-01T10:15:00Z'), 10);
    assertEqual(state.mode, 'active_today', 'Side-card should detect an active window today.');
    assertEqual(state.win.start, '2026-06-01T10:00:00.000Z', 'Active window start should be preserved.');
    assertEqual(state.win.end, '2026-06-01T10:30:00.000Z', 'Active window end should be preserved.');
    assertEqual(state.opts.activeNow, true, 'Active today mode should set the active-now flag.');
  });

  test('Side-card selects the next today window when current time is before it', () => {
    const rows = [
      row({ timeUtc: '2026-06-01T10:00:00Z', score: 20, confidence: 0.4, elevation: 8 }),
      row({ timeUtc: '2026-06-01T10:10:00Z', score: 66, confidence: 0.62, elevation: 12 }),
      row({ timeUtc: '2026-06-01T10:20:00Z', score: 71, confidence: 0.7, elevation: 18 }),
      row({ timeUtc: '2026-06-01T10:30:00Z', score: 18, confidence: 0.3, elevation: 15 }),
    ];
    const state = api.selectSideCardViewState(0, rows, {}, toMs('2026-06-01T10:00:00Z'), 10);
    assertEqual(state.mode, 'next_today', 'Side-card should detect an upcoming window today.');
    assertEqual(state.win.start, '2026-06-01T10:10:00.000Z', 'Upcoming window start should be preserved.');
    assertEqual(state.opts.heading, 'Next likely sun window today', 'Next-window heading should stay unchanged.');
  });

  test('Side-card falls back to tomorrow window when today has no meaningful window left', () => {
    const rows = [
      row({ timeUtc: '2026-06-01T10:00:00Z', score: 12, confidence: 0.3, elevation: 10 }),
      row({ timeUtc: '2026-06-01T10:10:00Z', score: 18, confidence: 0.35, elevation: 14 }),
      row({ timeUtc: '2026-06-01T10:20:00Z', score: 22, confidence: 0.38, elevation: 12 }),
    ];
    const tomorrowRows = [
      row({ timeUtc: '2026-06-02T13:00:00Z', dayIndex: 1, score: 65, confidence: 0.62, elevation: 20 }),
      row({ timeUtc: '2026-06-02T13:10:00Z', dayIndex: 1, score: 78, confidence: 0.7, elevation: 24 }),
      row({ timeUtc: '2026-06-02T13:20:00Z', dayIndex: 1, score: 72, confidence: 0.68, elevation: 22 }),
    ];
    const state = api.selectSideCardViewState(0, rows, { 1: tomorrowRows }, toMs('2026-06-01T12:00:00Z'), 10);
    assertEqual(state.mode, 'fallback_tomorrow', 'Side-card should fall back to tomorrow when today has no window.');
    assertEqual(state.isFallbackTomorrow, true, 'Fallback flag should be preserved.');
    assertEqual(state.win.start, '2026-06-02T13:00:00.000Z', 'Tomorrow window should be recomputed from forecast rows.');
    assertEqual(state.win.end, '2026-06-02T13:30:00.000Z', 'Tomorrow fallback should use the same sun-break rule.');
  });

  test('Side-card keeps a null window when neither today nor tomorrow has a meaningful window', () => {
    const rows = [
      row({ timeUtc: '2026-06-01T10:00:00Z', score: 5, confidence: 0.2, elevation: 6 }),
      row({ timeUtc: '2026-06-01T10:10:00Z', score: 8, confidence: 0.2, elevation: 8 }),
    ];
    const state = api.selectSideCardViewState(0, rows, {}, toMs('2026-06-01T11:00:00Z'), 10);
    assertEqual(state.mode, 'fallback_tomorrow', 'No-window case should still use fallback-tomorrow mode.');
    assertEqual(state.win, null, 'No-window case should keep a null side-card window.');
  });

  test('Tomorrow side-card uses the same 65/15 sun-break rule as today', () => {
    const rows = [
      row({ timeUtc: '2026-06-02T10:00:00Z', dayIndex: 1, score: 64, confidence: 0.45, elevation: 12 }),
      row({ timeUtc: '2026-06-02T10:10:00Z', dayIndex: 1, score: 65, confidence: 0.6, elevation: 18 }),
      row({ timeUtc: '2026-06-02T10:20:00Z', dayIndex: 1, score: 71, confidence: 0.68, elevation: 20 }),
      row({ timeUtc: '2026-06-02T10:30:00Z', dayIndex: 1, score: 40, confidence: 0.4, elevation: 16 }),
    ];
    const state = api.selectSideCardViewState(1, rows, { 1: rows }, toMs('2026-06-01T12:00:00Z'), 10);
    assertEqual(state.mode, 'tomorrow_selected', 'Tomorrow selection should keep the tomorrow mode.');
    assertEqual(state.win.start, '2026-06-02T10:10:00.000Z', 'Tomorrow window should start at the first 65+ row.');
    assertEqual(state.win.end, '2026-06-02T10:30:00.000Z', 'Two ten-minute rows should satisfy the 15-minute minimum.');
    assertEqual(state.opts.heading, 'Tomorrow’s likely sun window', 'Tomorrow heading should stay unchanged.');
  });

  test('Today theme selection passes sunrise and sunset as twilight context', () => {
    const rows = [
      row({ timeUtc: '2026-06-01T06:00:00Z', score: 42, confidence: 0.5, elevation: 2 }),
      row({ timeUtc: '2026-06-01T12:00:00Z', score: 88, confidence: 0.9, elevation: 40 }),
      row({ timeUtc: '2026-06-01T18:00:00Z', score: 26, confidence: 0.45, elevation: 1 }),
    ];
    const renderState = withTimezone('UTC', () => api.deriveForecastRenderState({
      data: { meta: { interval_minutes: 60 } },
      days: { 0: rows },
      dayIndex: 0,
      nowMs: toMs('2026-06-01T12:00:00Z'),
    }));
    assertEqual(renderState.theme.mode, 'today_live', 'Today theme mode should stay live.');
    assert(renderState.theme.twilightContext, 'Today theme should include twilight context.');
    assertEqual(renderState.theme.twilightContext.sunrise.toISOString(), '2026-06-01T06:00:00.000Z', 'Sunrise should come from the first daylight row.');
    assertEqual(renderState.theme.twilightContext.sunset.toISOString(), '2026-06-01T18:00:00.000Z', 'Sunset should come from the last daylight row.');
  });

  test('Tomorrow theme selection disables twilight context', () => {
    const rows = [
      row({ timeUtc: '2026-06-02T06:00:00Z', dayIndex: 1, score: 42, confidence: 0.5, elevation: 2 }),
      row({ timeUtc: '2026-06-02T12:00:00Z', dayIndex: 1, score: 88, confidence: 0.9, elevation: 40 }),
      row({ timeUtc: '2026-06-02T18:00:00Z', dayIndex: 1, score: 26, confidence: 0.45, elevation: 1 }),
    ];
    const renderState = withTimezone('UTC', () => api.deriveForecastRenderState({
      data: { meta: { interval_minutes: 60 } },
      days: { 1: rows },
      dayIndex: 1,
      nowMs: toMs('2026-06-01T12:00:00Z'),
    }));
    assertEqual(renderState.theme.mode, 'summary_static', 'Tomorrow theme mode should stay static.');
    assertEqual(renderState.theme.twilightContext, null, 'Tomorrow theme should not include twilight context.');
  });

  test('Tomorrow summary rows suppress twilight and night tint behavior', () => {
    const twilightContext = {
      sunrise: new Date('2026-01-15T19:00:00Z'),
      sunset: new Date('2026-01-15T19:00:00Z'),
    };
    const summaryNight = api.computeAtmosphericTheme({
      ...row({ timeUtc: '2026-01-15T19:00:00Z', dayIndex: 1, score: 72, confidence: 0.6, elevation: -7, isDaylight: false }),
      _themeFallback: true,
    }, twilightContext);
    const summaryDay = api.computeAtmosphericTheme({
      ...row({ timeUtc: '2026-01-15T19:00:00Z', dayIndex: 1, score: 72, confidence: 0.6, elevation: 25 }),
      _themeFallback: true,
    }, twilightContext);
    assertEqual(summaryNight.skyTop, summaryDay.skyTop, 'Summary rows should ignore elevation-based night tint.');
    assert(summaryNight.twTop.includes('/ 0.000)'), 'Summary rows should suppress twilight overlay alpha.');
  });

  test('Today timeline keeps future rows inside the padded daylight window and excludes past rows', () => {
    const rows = [
      row({ timeUtc: '2026-06-01T09:30:00Z', score: 5, confidence: 0.1, elevation: -2, isDaylight: false }),
      row({ timeUtc: '2026-06-01T10:00:00Z', score: 55, confidence: 0.52, elevation: 4 }),
      row({ timeUtc: '2026-06-01T10:10:00Z', score: 70, confidence: 0.65, elevation: 9 }),
      row({ timeUtc: '2026-06-01T10:20:00Z', score: 78, confidence: 0.72, elevation: 6 }),
      row({ timeUtc: '2026-06-01T10:40:00Z', score: 0, confidence: 0.25, elevation: -1, isDaylight: false }),
      row({ timeUtc: '2026-06-01T11:10:00Z', score: 0, confidence: 0.25, elevation: -4, isDaylight: false }),
    ];
    const chart = api.selectChartViewState(rows);
    const timeline = api.selectTimelineViewState(0, rows, chart.dayWin30, toMs('2026-06-01T10:12:00Z'));
    const visible = timeline.visibleRows.map((r) => r.time_utc);
    assertEqual(timeline.hasDaylightAhead, true, 'Today timeline should stay visible while daylight remains ahead.');
    assertEqual(JSON.stringify(visible), JSON.stringify([
      '2026-06-01T10:20:00Z',
      '2026-06-01T10:40:00Z',
    ]), 'Today timeline should exclude past rows but preserve padded-window rows.');
  });

  test('Tomorrow timeline keeps the full padded daylight window without today-style past filtering', () => {
    const rows = [
      row({ timeUtc: '2026-06-02T09:30:00Z', dayIndex: 1, score: 5, confidence: 0.1, elevation: -2, isDaylight: false }),
      row({ timeUtc: '2026-06-02T10:00:00Z', dayIndex: 1, score: 55, confidence: 0.52, elevation: 4 }),
      row({ timeUtc: '2026-06-02T10:10:00Z', dayIndex: 1, score: 70, confidence: 0.65, elevation: 9 }),
      row({ timeUtc: '2026-06-02T10:20:00Z', dayIndex: 1, score: 78, confidence: 0.72, elevation: 6 }),
      row({ timeUtc: '2026-06-02T10:40:00Z', dayIndex: 1, score: 0, confidence: 0.25, elevation: -1, isDaylight: false }),
      row({ timeUtc: '2026-06-02T11:10:00Z', dayIndex: 1, score: 0, confidence: 0.25, elevation: -4, isDaylight: false }),
    ];
    const chart = api.selectChartViewState(rows);
    const timeline = api.selectTimelineViewState(1, rows, chart.dayWin30, toMs('2026-06-01T10:12:00Z'));
    const visible = timeline.visibleRows.map((r) => r.time_utc);
    assertEqual(JSON.stringify(visible), JSON.stringify([
      '2026-06-02T09:30:00Z',
      '2026-06-02T10:00:00Z',
      '2026-06-02T10:10:00Z',
      '2026-06-02T10:20:00Z',
      '2026-06-02T10:40:00Z',
    ]), 'Tomorrow timeline should preserve the full padded daylight window.');
  });

  test('Valid forecast payload normalizes rows, meta, windows, and buckets correctly', () => {
    const normalized = api.normalizeForecastPayload({
      model: ' ray ',
      meta: { tz_name: ' America/Los_Angeles ', interval_minutes: '10' },
      timeline: [
        {
          time_utc: '2026-06-01T10:00:00Z',
          time_local: ' 2026-06-01T03:00:00-07:00 ',
          day_index: '1',
          sun_score: '82.5',
          confidence: '0.9',
          elevation: '24',
          azimuth: '190',
          cloud: { low: '12', mid: '34', high: '56', precip_mm: '0.8' },
        },
      ],
      next_sunny_window: { start: '2026-06-01T10:00:00Z', end: '2026-06-01T10:30:00Z', minutes: '30' },
      next_sunny_window_by_day: {
        1: { start: '2026-06-02T12:00:00Z', end: '2026-06-02T13:00:00Z', minutes: '60' },
      },
    });
    assertEqual(normalized.model, 'ray', 'Model should be trimmed.');
    assertEqual(normalized.meta.tz_name, 'America/Los_Angeles', 'Timezone name should be trimmed.');
    assertEqual(normalized.meta.interval_minutes, 10, 'Interval minutes should be coerced.');
    assertEqual(normalized.timeline[0].time_utc, '2026-06-01T10:00:00.000Z', 'UTC timestamp should normalize to ISO.');
    assertEqual(normalized.timeline[0].day_index, 1, 'Day index should normalize to integer.');
    assertEqual(normalized.timeline[0].sun_score, 82.5, 'Sun score should coerce to number.');
    assertEqual(normalized.timeline[0].confidence, 0.9, 'Confidence should coerce to number.');
    assertEqual(normalized.timeline[0].cloud.low, 12, 'Cloud low should normalize.');
    assertEqual(normalized.next_sunny_window.start, '2026-06-01T10:00:00.000Z', 'Window start should normalize to ISO.');
    assertEqual(normalized.days[1].length, 1, 'Normalized rows should be bucketed by day.');
  });

  test('Malformed forecast payloads fail in the intended controlled way', () => {
    assertThrows(
      () => api.normalizeForecastPayload(null),
      /expected object/i,
      'Non-object payloads should fail.'
    );
    assertThrows(
      () => api.normalizeForecastPayload({ timeline: [{}] }),
      /missing valid timestamp/i,
      'Rows without timestamps should fail.'
    );
    assertThrows(
      () => api.normalizeForecastPayload({ timeline: 'bad' }),
      /timeline must be an array/i,
      'Non-array timelines should fail.'
    );
  });

  test('Optional normalization defaults remain predictable for clouds, meta, and windows', () => {
    const normalized = api.normalizeForecastPayload({
      meta: { tz_name: '   ', interval_minutes: 'bad' },
      timeline: [
        {
          time_utc: '2026-06-01T10:00:00Z',
          day_index: 'bad',
          sun_score: 'bad',
          confidence: 'bad',
          elevation: 'bad',
          azimuth: 'bad',
          cloud: null,
        },
      ],
      next_sunny_window: { start: 'bad', end: '2026-06-01T10:30:00Z' },
      next_sunny_window_by_day: {
        0: { start: '2026-06-01T10:00:00Z', end: 'bad' },
      },
    });
    const firstRow = normalized.timeline[0];
    assertEqual(normalized.meta.tz_name, null, 'Blank timezone names should normalize to null.');
    assertEqual(normalized.meta.interval_minutes, 0, 'Invalid interval minutes should fall back to zero.');
    assertEqual(firstRow.day_index, 0, 'Invalid day index should fall back to day zero.');
    assertEqual(firstRow.sun_score, 0, 'Invalid sun score should fall back to zero.');
    assertEqual(firstRow.confidence, 0, 'Invalid confidence should fall back to zero.');
    assertEqual(firstRow.elevation, 0, 'Invalid elevation should fall back to zero.');
    assertEqual(firstRow.azimuth, 180, 'Invalid azimuth should fall back to 180.');
    assertEqual(firstRow.cloud.low, 0, 'Missing cloud fields should fall back to zero.');
    assertEqual(firstRow.cloud.precip_mm, 0, 'Missing precipitation should fall back to zero.');
    assertEqual(normalized.next_sunny_window, null, 'Invalid top-level windows should normalize to null.');
    assertEqual(normalized.next_sunny_window_by_day[0], null, 'Invalid day windows should normalize to null.');
  });

  test('Timeline rows preserve daylight fallback semantics during normalization', () => {
    const daylightRow = api.normalizeTimelineRow({
      time_utc: '2026-06-01T10:00:00Z',
      elevation: 4,
    });
    const nightRow = api.normalizeTimelineRow({
      time_utc: '2026-06-01T11:00:00Z',
      elevation: -2,
    });
    const explicitNight = api.normalizeTimelineRow({
      time_utc: '2026-06-01T12:00:00Z',
      elevation: 8,
      is_daylight: false,
    });
    assertEqual(daylightRow.is_daylight, true, 'Positive elevation should default to daylight.');
    assertEqual(nightRow.is_daylight, false, 'Negative elevation should default to not daylight.');
    assertEqual(explicitNight.is_daylight, false, 'Explicit daylight flags should be preserved.');
  });

  test('Invalid window structures normalize to null and valid windows derive minutes when needed', () => {
    const invalid = api.normalizeForecastWindow({ start: '2026-06-01T10:00:00Z', end: 'bad' });
    const derived = api.normalizeForecastWindow({ start: '2026-06-01T10:00:00Z', end: '2026-06-01T10:25:00Z' });
    assertEqual(invalid, null, 'Invalid windows should normalize to null.');
    assertEqual(derived.minutes, 25, 'Missing minutes should derive from the timestamp span.');
    assertEqual(derived.start, '2026-06-01T10:00:00.000Z', 'Derived windows should keep normalized ISO timestamps.');
  });

  test('Unchanged derived snapshots do not plan unnecessary surface updates', () => {
    const nowMs = toMs('2026-06-01T10:12:00Z');
    const { renderState, snapshot } = renderSnapshotAt({ nowMs });
    const plan = api.computeRenderPlan(snapshot, snapshot, { full: false });
    assertEqual(plan.updateDecision, false, 'Unchanged snapshots should skip decision rerenders.');
    assertEqual(plan.updateTheme, false, 'Unchanged snapshots should skip theme rerenders.');
    assertEqual(plan.updateSideCard, false, 'Unchanged snapshots should skip side-card rerenders.');
    assertEqual(plan.updateSunriseSunset, false, 'Unchanged snapshots should skip sunrise/sunset rerenders.');
    assertEqual(plan.updateTimeline, false, 'Unchanged snapshots should skip timeline rerenders.');
    assertEqual(plan.redrawChart, true, 'Chart redraw remains enabled for live marker updates.');
    assertEqual(renderState.decision.contextLabel, 'now', 'Render state should still derive normally.');
  });

  test('Minute-style snapshot changes only plan the intended time-sensitive surface updates', () => {
    const first = renderSnapshotAt({ nowMs: toMs('2026-06-01T10:12:00Z') });
    const second = renderSnapshotAt({ nowMs: toMs('2026-06-01T10:13:00Z') });
    const plan = api.computeRenderPlan(second.snapshot, first.snapshot, { full: false });
    assertEqual(plan.updateDecision, false, 'Minute changes should not rerender the decision when the focus row is unchanged.');
    assertEqual(plan.updateTheme, false, 'Minute changes should not rerender the theme when theme inputs are unchanged.');
    assertEqual(plan.updateSideCard, true, 'Minute changes should rerender the side-card when active remaining minutes changed.');
    assertEqual(plan.updateTimeline, false, 'Minute changes should not rerender timeline rows when visible rows are unchanged.');
    assertEqual(plan.redrawChart, true, 'Minute changes should keep the chart redraw path for the live marker.');
  });

  test('Full render plans still include all major surfaces when derived state changes', () => {
    const first = renderSnapshotAt({ nowMs: toMs('2026-06-01T10:12:00Z') });
    const second = renderSnapshotAt({ dayIndex: 1, nowMs: toMs('2026-06-01T10:12:00Z') });
    const plan = api.computeRenderPlan(second.snapshot, first.snapshot, { full: true, includeModelModeNote: true, includeRateLimitUi: true });
    assertEqual(plan.updateDecision, true, 'Full renders should include the decision surface.');
    assertEqual(plan.updateTheme, true, 'Full renders should include the theme surface.');
    assertEqual(plan.updateSideCard, true, 'Full renders should include the side-card surface.');
    assertEqual(plan.updateSunriseSunset, true, 'Full renders should include sunrise/sunset.');
    assertEqual(plan.updateTimeline, true, 'Full renders should include the timeline.');
    assertEqual(plan.updateModelModeNote, true, 'Full renders should include the model mode note when requested.');
    assertEqual(plan.updateRateLimitUi, true, 'Full renders should include rate-limit UI when requested.');
  });

  test('Snapshot keys and chart-axis keys change only on the intended inputs', () => {
    const fixture = renderFixtureData();
    const changed = clone(fixture);
    changed.days[0][2].confidence = 0.99;
    const first = renderSnapshotAt({ nowMs: toMs('2026-06-01T10:12:00Z'), fixture });
    const second = renderSnapshotAt({ nowMs: toMs('2026-06-01T10:12:00Z'), fixture: changed });
    assertNotEqual(first.snapshot.decisionKey, second.snapshot.decisionKey, 'Decision key should change when the selected row changes.');
    assertNotEqual(first.snapshot.timelineKey, second.snapshot.timelineKey, 'Timeline key should change when visible row data changes.');
    assertEqual(first.snapshot.chartAxisKey, second.snapshot.chartAxisKey, 'Chart-axis key should stay stable when only non-axis row fields change.');
  });

  test('Refresh-time path leaves unchanged surfaces alone while still updating the time-sensitive snapshot', () => {
    resetRenderRig();
    const { data, days } = renderFixtureData();
    api.setSelectorTestAppState({ data, days, tzName: 'UTC', dayIndex: 0, isBusy: false });
    withFixedNow(toMs('2026-06-01T10:12:00Z'), () => api.render());

    els.decisionText.textContent = 'decision sentinel';
    els.decisionContext.textContent = 'context sentinel';
    els.timeline.innerHTML = 'timeline sentinel';
    els.xAxis.innerHTML = 'x sentinel';
    els.yAxis.innerHTML = 'y sentinel';

    withFixedNow(toMs('2026-06-01T10:12:00Z'), () => api.refreshTimeSensitiveUi(true));

    assertEqual(els.decisionText.textContent, 'decision sentinel', 'Unchanged refreshes should not touch decision text.');
    assertEqual(els.decisionContext.textContent, 'context sentinel', 'Unchanged refreshes should not touch decision support text.');
    assertEqual(els.timeline.innerHTML, 'timeline sentinel', 'Unchanged refreshes should not rebuild the timeline.');
    assertEqual(els.xAxis.innerHTML, 'x sentinel', 'Unchanged refreshes should not rebuild chart x-axis labels.');
    assertEqual(els.yAxis.innerHTML, 'y sentinel', 'Unchanged refreshes should not rebuild chart y-axis labels.');
    assert(els.timePill.textContent && els.timePill.textContent !== '—', 'Refreshes should still keep the time pill live.');
  });

  test('Chart-only hover redraw leaves non-chart surfaces untouched', () => {
    resetRenderRig();
    const { data, days } = renderFixtureData();
    api.setSelectorTestAppState({ data, days, tzName: 'UTC', dayIndex: 0, isBusy: false });
    withFixedNow(toMs('2026-06-01T10:12:00Z'), () => api.redrawChartOnly());

    const before = api.getSelectorTestInternals();
    els.decisionText.textContent = 'decision sentinel';
    els.nextWindow.textContent = 'window sentinel';
    els.timeline.innerHTML = 'timeline sentinel';
    els.xAxis.innerHTML = 'x sentinel';
    els.yAxis.innerHTML = 'y sentinel';

    api.setSelectorTestChartHover({ active: true, idx: 2 });
    withFixedNow(toMs('2026-06-01T10:12:00Z'), () => api.redrawChartOnly());

    const after = api.getSelectorTestInternals();
    assertEqual(els.decisionText.textContent, 'decision sentinel', 'Hover redraws should not touch decision text.');
    assertEqual(els.nextWindow.textContent, 'window sentinel', 'Hover redraws should not touch the side-card value.');
    assertEqual(els.timeline.innerHTML, 'timeline sentinel', 'Hover redraws should not rebuild the timeline.');
    assertEqual(els.xAxis.innerHTML, 'x sentinel', 'Hover redraws should not rebuild the x-axis when the dataset is unchanged.');
    assertEqual(els.yAxis.innerHTML, 'y sentinel', 'Hover redraws should not rebuild the y-axis when the dataset is unchanged.');
    assertEqual(after.chartAxisKey, before.chartAxisKey, 'Hover redraws should preserve the same chart-axis key.');
  });

  test('Chart-axis rebuild gating still responds only to real axis-input changes', () => {
    resetRenderRig();
    const { data, days } = renderFixtureData();
    api.setSelectorTestAppState({ data, days, tzName: 'UTC', dayIndex: 0, isBusy: false });
    withFixedNow(toMs('2026-06-01T10:12:00Z'), () => api.redrawChartOnly());
    const firstAxisKey = api.getSelectorTestInternals().chartAxisKey;

    els.xAxis.innerHTML = 'x sentinel';
    els.yAxis.innerHTML = 'y sentinel';
    withFixedNow(toMs('2026-06-01T10:13:00Z'), () => api.redrawChartOnly());
    assertEqual(els.xAxis.innerHTML, 'x sentinel', 'Chart redraws should keep x-axis markup when the axis key is unchanged.');
    assertEqual(els.yAxis.innerHTML, 'y sentinel', 'Chart redraws should keep y-axis markup when the axis key is unchanged.');

    api.setSelectorTestAppState({ data, days, tzName: 'Europe/Amsterdam', dayIndex: 0, isBusy: false });
    withFixedNow(toMs('2026-06-01T10:13:00Z'), () => api.redrawChartOnly());
    const secondAxisKey = api.getSelectorTestInternals().chartAxisKey;
    assertNotEqual(secondAxisKey, firstAxisKey, 'Changing timezone should change the chart-axis key.');
    assertNotEqual(els.xAxis.innerHTML, 'x sentinel', 'Changed axis inputs should rebuild x-axis markup.');
    assertNotEqual(els.yAxis.innerHTML, 'y sentinel', 'Changed axis inputs should rebuild y-axis markup.');
  });

  const results = tests.map(({ name, fn }) => {
    try {
      fn();
      return { name, pass: true, detail: 'Passed.' };
    } catch (err) {
      return {
        name,
        pass: false,
        detail: err && err.message ? err.message : String(err),
      };
    }
  });

  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.length - passCount;
  summaryStatusEl.textContent = failCount === 0 ? 'All frontend logic tests passed' : `${failCount} frontend logic test(s) failed`;
  summaryStatusEl.className = `status ${failCount === 0 ? 'ok' : 'fail'}`;
  summaryMetaEl.textContent = `${passCount}/${results.length} scenarios passed.`;

  results.forEach((result) => {
    const article = document.createElement('article');
    article.className = `result ${result.pass ? 'pass' : 'fail'}`;

    const title = document.createElement('h2');
    title.textContent = `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}`;
    article.appendChild(title);

    const detail = document.createElement('p');
    detail.textContent = result.detail;
    article.appendChild(detail);

    resultsEl.appendChild(article);
  });
})();
