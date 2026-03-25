'use strict';

/**
 * Main frontend controller for iwannasun.
 * Responsibilities: location handling, forecast fetching/caching, cooldown UX,
 * and rendering the decision, metrics, chart, timeline, and time indicators.
 */

// ===== Config =====
const API_BASE =
  (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
    ? 'http://127.0.0.1:8000'
    : 'https://api.iwannasun.com';
const DEFAULT_THRESHOLD = 70;
const SIDE_CARD_THRESHOLD = 60;
const DAYS = 2;
const COORD_STATE_DECIMALS = 3;
const COORD_CACHE_KEY_DECIMALS = 3;
const MEANINGFUL_WINDOW_MINUTES = 20;
const SIDE_CARD_MEANINGFUL_WINDOW_MINUTES = 10;

// Timeline limits
const TIMELINE_MAX_ROWS = 84;

// Rate limiting
const RL_STORAGE_KEY = 'iwannasun_rate_limit_until';
const RL_PROVIDER_DEFAULT_COOLDOWN_S = 15; // Open-Meteo / forecast provider
const RL_USER_DEFAULT_COOLDOWN_S = 10;     // your API (slow down)

// ===== DOM =====
const $ = (id) => document.getElementById(id);

const els = {
  timePill: $('timePill'),
  cityWrap: document.querySelector('.cityWrap'),
  cityInput: $('cityInput'),
  cityResults: $('cityResults'),
  btnClearLocation: $('btnClearLocation'),
  errBox: $('errBox'),
  modelModeNote: $('modelModeNote'),
  loadingOverlay: $('loadingOverlay'),

  btnHere: $('btnHere'),
  btnRefresh: $('btnRefresh'),
  daySelect: $('daySelect'),

  decisionWrap: $('decisionWrap'),
  decisionLead: $('decisionLead'),
  decisionText: $('decisionText'),
  decisionContext: $('decisionContext'),
  whyInline: $('whyInline'),

  labelScore: $('labelScore'),
  labelConf: $('labelConf'),

  scoreNow: $('scoreNow'),
  confNow: $('confNow'),

  meterScore: $('meterScore'),
  meterConf: $('meterConf'),
  sunQualityLegend: $('sunQualityLegend'),

  nextWindow: $('nextWindow'),
  nextWindowHeading: $('nextWindowHeading'),
  nextWindowSub: $('nextWindowSub'),
  sunriseTime: $('sunriseTime'),
  sunsetTime: $('sunsetTime'),

  timeline: $('timeline'),
  yAxis: $('yAxis'),
  xAxis: $('xAxis'),
  canvas: $('sunChart'),
};

const ctx = els.canvas ? els.canvas.getContext('2d') : null;
const IWS_SELECTOR_TEST_MODE = Boolean(
  typeof window !== 'undefined' && window.IWS_SELECTOR_TEST_MODE === true
);

function updateClearLocationButton() {
  if (!els.btnClearLocation || !els.cityInput) return;
  const hasValue = String(els.cityInput.value || '').trim().length > 0;
  els.btnClearLocation.hidden = !hasValue;
  els.btnClearLocation.disabled = !hasValue;
}

updateClearLocationButton();

// ===== State =====
const state = {
  lat: null,
  lon: null,
  label: '',
  data: null,
  days: null,
  tzName: null,
  geometryMode: null,
  rayFallbackActive: false,
  rayFallbackReason: '',
  isBusy: false,
  rateLimitUntil: 0,
  rateLimitMsg: '',
};

let _lastAtmosThemeKey = '';
let _lastRenderSnapshot = null;
let _chartAxisKey = '';

// ===== Request control =====
let _dayAbort = null;
let _fetchDaySeq = 0;
let _activeFetchDaySeq = 0;
let _locationSeq = 0;

// ===== Helpers =====
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function roundCoord(x, decimals = 3) {
  const p = Math.pow(10, decimals);
  return Math.round(Number(x) * p) / p;
}
const nextPaint = () => new Promise((r) => requestAnimationFrame(r));

function blendRgb(a, b, t) {
  const u = clamp(Number(t || 0), 0, 1);
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
  };
}

function sunScoreRgb(t) {
  const u = clamp(Number(t || 0), 0, 1);
  // Shared score palette used by chart/title/timeline and now atmospheric source glow.
  const mutedLow = { r: 160, g: 162, b: 144 };
  const muted = { r: 186, g: 176, b: 136 };
  const pale = { r: 214, g: 190, b: 118 };
  const warm = { r: 236, g: 176, b: 74 };
  const gold = { r: 246, g: 186, b: 62 };

  if (u >= 0.9) return blendRgb(warm, gold, (u - 0.9) / 0.1);
  if (u >= 0.7) return blendRgb(pale, warm, (u - 0.7) / 0.2);
  if (u >= 0.5) return blendRgb(muted, pale, (u - 0.5) / 0.2);
  return blendRgb(mutedLow, muted, u / 0.5);
}

// Debounce helper (mobile resize/orientation can fire many events)
function debounce(fn, waitMs = 120) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), waitMs);
  };
}

// Coalesce render calls (prevents thrash on mobile when layout changes)
let _renderQueued = false;
function renderSoon() {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => {
    _renderQueued = false;
    render();
  });
}

// Chart hover inspector state (desktop/pointer devices)
const _chartHover = { active: false, idx: -1 };
let _chartGeom = null;

function clearChartHover() {
  if (!_chartHover.active && _chartHover.idx < 0) return;
  _chartHover.active = false;
  _chartHover.idx = -1;
  redrawChartOnly();
}

function chartHoverIndexFromClientX(clientX) {
  if (!els.canvas || !_chartGeom || _chartGeom.ptsLen < 1) return -1;
  const rect = els.canvas.getBoundingClientRect();
  const localX = clientX - rect.left;
  const minX = _chartGeom.padX;
  const maxX = _chartGeom.w - _chartGeom.padX;
  const clampedX = clamp(localX, minX, maxX);
  const span = Math.max(1, maxX - minX);
  const u = (clampedX - minX) / span;
  return clamp(Math.round(u * (_chartGeom.ptsLen - 1)), 0, _chartGeom.ptsLen - 1);
}

function updateChartHoverFromClientX(clientX) {
  const idx = chartHoverIndexFromClientX(clientX);
  if (idx < 0) return;
  if (_chartHover.active && _chartHover.idx === idx) return;
  _chartHover.active = true;
  _chartHover.idx = idx;
  redrawChartOnly();
}

function showError(msg) {
  if (!els.errBox) return;
  els.errBox.style.display = 'block';
  els.errBox.textContent = msg;
}
function clearError() {
  if (!els.errBox) return;
  els.errBox.style.display = 'none';
  els.errBox.textContent = '';
}

function setLabelLeadText(el, text) {
  if (!el) return;
  let lead = el.querySelector('[data-label-lead]');
  if (!lead) {
    lead = document.createElement('span');
    lead.setAttribute('data-label-lead', 'true');
    const first = el.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) {
      lead.textContent = first.textContent || '';
      el.replaceChild(lead, first);
    } else {
      el.insertAdjacentElement('afterbegin', lead);
    }
  }
  lead.textContent = text;
}

function clearForecastUi() {
  _chartHover.active = false;
  _chartHover.idx = -1;
  _chartGeom = null;
  _lastAtmosThemeKey = '';
  _lastRenderSnapshot = null;
  _chartAxisKey = '';

  if (els.timePill) {
    els.timePill.textContent = '—';
    els.timePill.title = '';
  }

  if (els.decisionLead) els.decisionLead.textContent = '';
  if (els.labelScore) els.labelScore.textContent = 'Sun score now';
  if (els.labelConf) setLabelLeadText(els.labelConf, 'Confidence now ');
  if (els.decisionText) els.decisionText.textContent = '—';
  if (els.decisionWrap) els.decisionWrap.style.color = '';
  if (els.scoreNow) els.scoreNow.textContent = '—';
  if (els.confNow) {
    els.confNow.textContent = '—';
    els.confNow.title = '';
  }
  if (els.decisionContext) els.decisionContext.textContent = '';
  if (els.whyInline) {
    els.whyInline.textContent = '';
    els.whyInline.classList.remove('secondaryLine');
  }
  setMeter(els.meterScore, 0, 'rgba(51,51,51,0.10)');
  setMeter(els.meterConf, 0, 'rgba(51,51,51,0.10)');

  if (els.nextWindowHeading) els.nextWindowHeading.textContent = 'Your next sun break';
  if (els.nextWindow) {
    els.nextWindow.textContent = '—';
    els.nextWindow.classList.add('big');
    els.nextWindow.classList.remove('good', 'bad');
  }
  if (els.nextWindowSub) els.nextWindowSub.textContent = '—';

  if (els.sunriseTime) {
    els.sunriseTime.textContent = '—';
    els.sunriseTime.title = '';
  }
  if (els.sunsetTime) {
    els.sunsetTime.textContent = '—';
    els.sunsetTime.title = '';
  }

  if (els.timeline) {
    els.timeline.style.display = 'none';
    els.timeline.innerHTML = '';
  }

  renderChart([], null);

  if (els.modelModeNote) {
    els.modelModeNote.style.display = 'none';
    els.modelModeNote.textContent = '';
  }

  applyAtmosphericTheme(null);
}

function setBusy(isBusy) {
  state.isBusy = !!isBusy;

  if (els.loadingOverlay) {
    els.loadingOverlay.style.display = isBusy ? 'flex' : 'none';
    els.loadingOverlay.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  }

  const disable = [els.btnHere, els.btnRefresh, els.daySelect, els.cityInput].filter(Boolean);
  for (const el of disable) el.disabled = !!isBusy;

  // rate-limit cooldown can also disable refresh (even when not busy)
  applyRateLimitUi();

  const fade = [els.btnHere, els.btnRefresh].filter(Boolean);
  for (const el of fade) el.style.opacity = isBusy ? '0.65' : '1';
}

// Escape text for HTML injection safety
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Format times in the location timezone
const _fmtCache = new Map();
const _hourFmtCache = new Map();
function getFormatters() {
  const tz = state.tzName || '';
  if (_fmtCache.has(tz)) return _fmtCache.get(tz);

  const make = (opts) => {
    try { return new Intl.DateTimeFormat([], tz ? { ...opts, timeZone: tz } : opts); }
    catch { return new Intl.DateTimeFormat([], opts); }
  };

  const f = {
    hm: make({ hour: '2-digit', minute: '2-digit' }),
    h: make({ hour: '2-digit' }),
    full: make({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
  };
  _fmtCache.set(tz, f);
  return f;
}
const fmtTime = (v) => getFormatters().hm.format(v instanceof Date ? v : new Date(v));
const fmtDateTime = (v) => getFormatters().full.format(v instanceof Date ? v : new Date(v));

function getHourFormatter() {
  const tz = state.tzName || '';
  if (_hourFmtCache.has(tz)) return _hourFmtCache.get(tz);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz || undefined,
    });
  } catch {
    f = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  _hourFmtCache.set(tz, f);
  return f;
}

function localHourForDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    const n = new Date();
    return n.getHours() + (n.getMinutes() / 60);
  }
  try {
    const parts = getHourFormatter().formatToParts(date);
    let hh = NaN;
    let mm = 0;
    for (const p of parts) {
      if (p.type === 'hour') hh = Number(p.value);
      if (p.type === 'minute') mm = Number(p.value);
    }
    if (Number.isFinite(hh)) return hh + ((Number.isFinite(mm) ? mm : 0) / 60);
  } catch {
    // Fall through to local browser clock parsing.
  }
  return date.getHours() + (date.getMinutes() / 60);
}

// Daylight detection
function isDaylightRow(r) {
  if (!r) return false;
  if (typeof r.is_daylight === 'boolean') return r.is_daylight;
  return Number(r.elevation || 0) > 0;
}

// Timeline rows contain ISO strings.
// IMPORTANT: Use time_utc (authoritative) for Date parsing/comparisons.
// - If time_local has no timezone offset, new Date(time_local) would be interpreted in viewer timezone.
// - time_utc is safe to parse everywhere and we format it into meta.tz_name for display.
function tUtc(r) {
  if (!r) return null;
  if (r._tUtc instanceof Date) return r._tUtc;
  const src = r.time_utc || r.time_local;
  const d = new Date(src);
  r._tUtc = d;
  r._tMs = d.getTime();
  return d;
}
const tMs = (r) => (r && typeof r._tMs === 'number') ? r._tMs : (tUtc(r)?.getTime() ?? NaN);

// Derived forecast selectors live in a dedicated file so rules stay decoupled from DOM rendering.
const forecastSelectors = window.IWSForecastSelectors?.createForecastSelectors?.({
  isDaylightRow,
  tUtc,
  tMs,
  localHourForDate,
  config: {
    DEFAULT_THRESHOLD,
    MEANINGFUL_WINDOW_MINUTES,
    SIDE_CARD_THRESHOLD,
    SIDE_CARD_MEANINGFUL_WINDOW_MINUTES,
    TIMELINE_MAX_ROWS,
  },
});

if (!forecastSelectors) {
  throw new Error('IWS forecast selectors module failed to load.');
}

const {
  daylightWindow,
  meaningfulWindows,
  chartRowsForWindow,
  maxElevationFromRows,
  nearestRowToLocalHour,
  selectDecisionViewState,
  selectSideCardViewState,
  selectThemeViewState,
  selectChartViewState,
  visibleTimelineRows,
  selectTimelineViewState,
  deriveForecastRenderState,
} = forecastSelectors;

class ForecastNormalizationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ForecastNormalizationError';
    this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toTrimmedStringOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function toFiniteNumberOrFallback(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeClampedNumber(value, {
  fallback = 0,
  min = -Infinity,
  max = Infinity,
} = {}) {
  return clamp(toFiniteNumberOrFallback(value, fallback), min, max);
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeForecastWindow(rawWindow) {
  if (!isPlainObject(rawWindow)) return null;
  const startDate = normalizeTimestamp(rawWindow.start);
  const endDate = normalizeTimestamp(rawWindow.end);
  if (!startDate || !endDate) return null;

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  const minutesRaw = Number(rawWindow.minutes);
  const minutes = (Number.isFinite(minutesRaw) && minutesRaw >= 0)
    ? Math.round(minutesRaw)
    : Math.max(0, Math.round((endMs - startMs) / 60000));

  return {
    ...rawWindow,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    minutes,
  };
}

function normalizeForecastWindowMap(rawMap) {
  if (!isPlainObject(rawMap)) return null;
  const out = {};
  for (const [key, value] of Object.entries(rawMap)) {
    out[String(key)] = normalizeForecastWindow(value);
  }
  return out;
}

function normalizeCloudFields(rawCloud) {
  const cloud = isPlainObject(rawCloud) ? rawCloud : {};
  return {
    ...cloud,
    low: normalizeClampedNumber(cloud.low, { fallback: 0, min: 0, max: 100 }),
    mid: normalizeClampedNumber(cloud.mid, { fallback: 0, min: 0, max: 100 }),
    high: normalizeClampedNumber(cloud.high, { fallback: 0, min: 0, max: 100 }),
    precip_mm: Math.max(0, toFiniteNumberOrFallback(cloud.precip_mm, 0)),
  };
}

function normalizeDayIndex(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

function normalizeTimelineRow(rawRow, rowIndex = 0) {
  if (!isPlainObject(rawRow)) {
    throw new ForecastNormalizationError('Malformed forecast row: expected object.', { rowIndex });
  }

  const parsedUtc = normalizeTimestamp(rawRow.time_utc || rawRow.time_local);
  if (!parsedUtc) {
    throw new ForecastNormalizationError('Malformed forecast row: missing valid timestamp.', {
      rowIndex,
      time_utc: rawRow.time_utc ?? null,
      time_local: rawRow.time_local ?? null,
    });
  }

  const elevation = toFiniteNumberOrFallback(rawRow.elevation, 0);
  const confidence = normalizeClampedNumber(rawRow.confidence, { fallback: 0, min: 0, max: 1 });
  const sunScore = normalizeClampedNumber(rawRow.sun_score, { fallback: 0, min: 0, max: 100 });

  const normalized = {
    ...rawRow,
    day_index: normalizeDayIndex(rawRow.day_index),
    time_utc: parsedUtc.toISOString(),
    time_local: toTrimmedStringOrNull(rawRow.time_local),
    sun_score: sunScore,
    confidence,
    elevation,
    azimuth: toFiniteNumberOrFallback(rawRow.azimuth, 180),
    is_daylight: (typeof rawRow.is_daylight === 'boolean') ? rawRow.is_daylight : elevation > 0,
    cloud: normalizeCloudFields(rawRow.cloud),
    _tUtc: parsedUtc,
    _tMs: parsedUtc.getTime(),
  };

  return normalized;
}

function bucketForecastRowsByDay(timelineRows) {
  const days = {};
  for (const row of (timelineRows || [])) {
    const dayIndex = normalizeDayIndex(row?.day_index);
    (days[dayIndex] ||= []).push(row);
  }
  for (const key of Object.keys(days)) {
    days[key].sort((a, b) => tMs(a) - tMs(b));
  }
  return days;
}

function normalizeForecastMeta(rawMeta) {
  const meta = isPlainObject(rawMeta) ? rawMeta : {};
  const intervalMinutes = toFiniteNumberOrFallback(meta.interval_minutes, 0);
  return {
    ...meta,
    tz_name: toTrimmedStringOrNull(meta.tz_name),
    interval_minutes: (Number.isFinite(intervalMinutes) && intervalMinutes > 0) ? intervalMinutes : 0,
  };
}

function normalizeForecastPayload(rawData) {
  if (!isPlainObject(rawData)) {
    throw new ForecastNormalizationError('Malformed forecast payload: expected object.');
  }
  if (!Array.isArray(rawData.timeline)) {
    throw new ForecastNormalizationError('Malformed forecast payload: timeline must be an array.');
  }

  const timeline = rawData.timeline.map((row, idx) => normalizeTimelineRow(row, idx));
  const days = bucketForecastRowsByDay(timeline);

  return {
    ...rawData,
    model: toTrimmedStringOrNull(rawData.model),
    meta: normalizeForecastMeta(rawData.meta),
    timeline,
    days,
    next_sunny_window: normalizeForecastWindow(rawData.next_sunny_window),
    next_sunny_window_by_day: normalizeForecastWindowMap(rawData.next_sunny_window_by_day),
  };
}

// Day bucketing
function prepData(data) {
  if (!data) {
    state.days = null;
    return;
  }
  if (isPlainObject(data.days)) {
    state.days = data.days;
    return;
  }
  state.days = bucketForecastRowsByDay(data.timeline || []);
}

// Color mix: 0 = cloudy, 1 = sunny
function mixSunColor(t, alpha = 1) {
  const rgb = sunScoreRgb(t);
  const aa = clamp(alpha, 0, 1);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${aa})`;
}

function toNumberOrNaN(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function cloudFragilityFromRow(row) {
  if (!row || !row.cloud) return 0;
  const low = toNumberOrNaN(row.cloud.low);
  const mid = toNumberOrNaN(row.cloud.mid);
  const high = toNumberOrNaN(row.cloud.high);
  const vals = [low, mid, high].filter(Number.isFinite);
  if (!vals.length) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const spread = (Math.max(...vals) - Math.min(...vals)) / 100;
  const transition = (mean > 15 && mean < 90) ? 1 : 0;
  return clamp(0.4 * spread + 0.35 * transition, 0, 1);
}

function twilightBellAt(nowMs, centerMs, leftMinutes, rightMinutes) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(centerMs)) return 0;
  const leftMs = Math.max(1, Number(leftMinutes || 0) * 60000);
  const rightMs = Math.max(1, Number(rightMinutes || 0) * 60000);
  const dt = nowMs - centerMs;
  if (dt < -leftMs || dt > rightMs) return 0;
  const norm = dt < 0 ? (-dt / leftMs) : (dt / rightMs); // 0 at center, 1 at edge
  return 0.5 * (Math.cos(Math.PI * norm) + 1);
}

function computeAtmosphericTheme(row, twilightContext = null) {
  const now = new Date();
  const score = clamp(toNumberOrNaN(row?.sun_score) || 0, 0, 100);
  const sunT = score / 100;
  const elev = toNumberOrNaN(row?.elevation);

  const rowDate = row ? tUtc(row) : null;
  const refDate = (rowDate instanceof Date && !Number.isNaN(rowDate.getTime()))
    ? rowDate
    : now;
  const elevClamped = Number.isFinite(elev) ? clamp(elev, -10, 90) : 0;
  const isTomorrowSummary = Boolean(row && row._themeFallback === true);

  // 1) Day base (score only)
  const dayHue = 205 - 10 * sunT;
  const daySat = 18 + 70 * sunT;
  const topL = 56 + 24 * sunT;
  const midL = 72 + 18 * sunT;
  const botL = 88 + 10 * sunT;

  const baseTop = { h: dayHue, s: clamp(daySat * 0.95, 0, 100), l: clamp(topL, 0, 100) };
  const baseMid = { h: dayHue, s: clamp(daySat * 0.75, 0, 100), l: clamp(midL, 0, 100) };
  const baseBottom = { h: dayHue, s: clamp(daySat * 0.36, 0, 100), l: clamp(botL, 0, 100) };

  // 2) Night tint (elevation only), disabled for tomorrow summary mode.
  const nightT = isTomorrowSummary ? 0 : clamp((0 - elevClamped) / 10, 0, 1);
  const nightAlpha = 0.55 * nightT;
  const nightTop = { h: 250, s: 55, l: 38, a: nightAlpha };
  const nightMid = { h: 248, s: 50, l: 45, a: nightAlpha };
  const nightBottom = { h: 245, s: 45, l: 58, a: nightAlpha };

  function hslToRgb(h, s, l) {
    const hh = ((Number(h) % 360) + 360) % 360;
    const ss = clamp(Number(s) / 100, 0, 1);
    const ll = clamp(Number(l) / 100, 0, 1);
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = ll - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (hh < 60) { r1 = c; g1 = x; b1 = 0; }
    else if (hh < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (hh < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (hh < 240) { r1 = 0; g1 = x; b1 = c; }
    else if (hh < 300) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255),
    };
  }

  function overlayRgb(base, over) {
    const a = clamp(Number(over.a || 0), 0, 1);
    return {
      r: Math.round(base.r * (1 - a) + over.r * a),
      g: Math.round(base.g * (1 - a) + over.g * a),
      b: Math.round(base.b * (1 - a) + over.b * a),
    };
  }

  const skyTopRgb = overlayRgb(
    hslToRgb(baseTop.h, baseTop.s, baseTop.l),
    { ...hslToRgb(nightTop.h, nightTop.s, nightTop.l), a: nightTop.a }
  );
  const skyMidRgb = overlayRgb(
    hslToRgb(baseMid.h, baseMid.s, baseMid.l),
    { ...hslToRgb(nightMid.h, nightMid.s, nightMid.l), a: nightMid.a }
  );
  const skyBottomRgb = overlayRgb(
    hslToRgb(baseBottom.h, baseBottom.s, baseBottom.l),
    { ...hslToRgb(nightBottom.h, nightBottom.s, nightBottom.l), a: nightBottom.a }
  );

  const skyTop = `rgb(${skyTopRgb.r}, ${skyTopRgb.g}, ${skyTopRgb.b})`;
  const skyMid = `rgb(${skyMidRgb.r}, ${skyMidRgb.g}, ${skyMidRgb.b})`;
  const skyBottom = `rgb(${skyBottomRgb.r}, ${skyBottomRgb.g}, ${skyBottomRgb.b})`;

  // 3) Twilight overlay (timing only), disabled for tomorrow summary mode.
  const nowMs = refDate.getTime();
  const sunriseMs = Number.isFinite(twilightContext?.sunrise?.getTime?.())
    ? twilightContext.sunrise.getTime()
    : NaN;
  const sunsetMs = Number.isFinite(twilightContext?.sunset?.getTime?.())
    ? twilightContext.sunset.getTime()
    : NaN;
  const sunriseW = Number.isFinite(sunriseMs)
    ? twilightBellAt(nowMs, sunriseMs, 30, 60)
    : 0;
  const sunsetW = Number.isFinite(sunsetMs)
    ? twilightBellAt(nowMs, sunsetMs, 60, 30)
    : 0;
  const twilightRaw = Math.max(sunriseW, sunsetW);
  const twilightW = isTomorrowSummary ? 0 : twilightRaw;
  const twAlpha = clamp(twilightW * 0.5, 0, 1);
  const twTop = `hsl(280 70% 60% / ${(twAlpha * 0.8).toFixed(3)})`;
  const twMid = `hsl(330 75% 70% / ${(twAlpha * 1.0).toFixed(3)})`;
  const twBottom = `hsl(30 80% 75% / ${(twAlpha * 0.9).toFixed(3)})`;

  const cardAlpha = clamp(0.60 - 0.04 * sunT, 0.54, 0.72);
  const cardAlpha2 = clamp(cardAlpha - 0.07, 0.46, 0.64);

  return {
    skyTop,
    skyMid,
    skyBottom,
    twTop,
    twMid,
    twBottom,
    card: `rgba(255, 255, 255, ${cardAlpha.toFixed(3)})`,
    card2: `rgba(255, 255, 255, ${cardAlpha2.toFixed(3)})`,
  };
}

function applyAtmosphericTheme(row, twilightContext = null) {
  if (!document.body || document.body.classList.contains('solarApiPage')) return;
  const root = document.documentElement;
  if (!root) return;
  const theme = computeAtmosphericTheme(row || null, twilightContext);
  const themeKey = [
    theme.skyTop,
    theme.skyMid,
    theme.skyBottom,
    theme.twTop,
    theme.twMid,
    theme.twBottom,
    theme.card,
    theme.card2,
  ].join('|');
  if (themeKey === _lastAtmosThemeKey) return;
  _lastAtmosThemeKey = themeKey;
  root.style.setProperty('--atm-sky-top', theme.skyTop);
  root.style.setProperty('--atm-sky-mid', theme.skyMid);
  root.style.setProperty('--atm-sky-bottom', theme.skyBottom);
  root.style.setProperty('--atm-tw-top', theme.twTop);
  root.style.setProperty('--atm-tw-mid', theme.twMid);
  root.style.setProperty('--atm-tw-bottom', theme.twBottom);
  root.style.setProperty('--atm-card', theme.card);
  root.style.setProperty('--atm-card-2', theme.card2);
}

// ===== Rate limit cooldown =====
let _rlTimer = null;
function ensureRateLimitTimer() {
  if (_rlTimer) {
    clearInterval(_rlTimer);
    _rlTimer = null;
  }
  if (rateLimitRemainingMs() <= 0) return;
  _rlTimer = setInterval(() => {
    if (Date.now() >= state.rateLimitUntil) {
      clearRateLimit();
      clearError();
    } else {
      applyRateLimitUi();
    }
  }, 500);
}

function loadRateLimitUntil() {
  try {
    const raw = sessionStorage.getItem(RL_STORAGE_KEY);
    const v = Number(raw || 0);
    if (!Number.isFinite(v) || v <= 0) return;
    if (v <= Date.now()) {
      clearRateLimit();
      return;
    }
    state.rateLimitUntil = v;
    ensureRateLimitTimer();
    applyRateLimitUi();
  } catch { /* ignore */ }
}
function saveRateLimitUntil(ts) {
  try { sessionStorage.setItem(RL_STORAGE_KEY, String(ts || 0)); } catch { /* ignore */ }
}
function clearRateLimit() {
  state.rateLimitUntil = 0;
  state.rateLimitMsg = '';
  saveRateLimitUntil(0);
  if (_rlTimer) { clearInterval(_rlTimer); _rlTimer = null; }
  applyRateLimitUi();
}
function startRateLimitCooldown(seconds, message = '') {
  const s = clamp(Number(seconds || 0), 5, 15 * 60);
  state.rateLimitUntil = Date.now() + s * 1000;
  state.rateLimitMsg = String(message || '').trim();
  saveRateLimitUntil(state.rateLimitUntil);

  ensureRateLimitTimer();
  applyRateLimitUi();
}
function rateLimitRemainingMs() {
  return Math.max(0, state.rateLimitUntil - Date.now());
}
function applyRateLimitUi() {
  const remMs = rateLimitRemainingMs();
  const active = remMs > 0;

  if (els.btnRefresh) {
    // Only disable refresh for cooldown (other controls still work)
    const shouldDisable = active || state.isBusy;
    els.btnRefresh.disabled = !!shouldDisable;
    els.btnRefresh.title = active
      ? `Rate limited. Try again in ${Math.ceil(remMs / 1000)}s.`
      : 'Refresh data';
  }

  if (active) {
    const secs = Math.ceil(remMs / 1000);
    const msg = state.rateLimitMsg || 'Please wait a moment before trying again.';
    showError(`${msg} Try again in ${secs}s.`);
  }
}

function handleCooldownResponse(res, defaultSeconds, maxSeconds, message) {
  const ra = res.headers?.get?.('Retry-After');
  let cooldown = defaultSeconds;
  if (ra && /^\d+$/.test(ra)) {
    cooldown = clamp(Number(ra), 5, maxSeconds);
  }
  startRateLimitCooldown(cooldown, message);
}

// ===== Location =====
function setLocation(lat, lon, label = '') {
  _locationSeq += 1;
  state.lat = roundCoord(lat, COORD_STATE_DECIMALS);
  state.lon = roundCoord(lon, COORD_STATE_DECIMALS);
  state.label = (label || '').trim();

  state.data = null;
  state.days = null;
  state.tzName = null;

  if (els.timePill) {
    els.timePill.textContent = '—';
    els.timePill.title = '';
  }
  // For the input: if label is "My location", keep it empty (so it doesn't look like a locked value)
  if (els.cityInput) {
    els.cityInput.value = (state.label && state.label !== 'My location') ? state.label : '';
  }
  updateClearLocationButton();
  clearForecastUi();
}

// ===== City search (Open-Meteo geocoding) =====
let _cityTimer = null;
let _lastCityQuery = '';
let _lastCityResults = [];
let _cityActiveIndex = -1;
let _citySearchSeq = 0;
let _activeCitySearchSeq = 0;

function hideCityResults() {
  if (!els.cityResults) return;
  els.cityResults.style.display = 'none';
  els.cityResults.innerHTML = '';
  _cityActiveIndex = -1;
  if (els.cityInput) els.cityInput.setAttribute('aria-expanded', 'false');
}

function renderCityResults(list) {
  if (!els.cityResults) return;
  if (!list?.length) return hideCityResults();

  els.cityResults.innerHTML = list.map((r, idx) => {
    const name = esc(r.name || '—');
    // Keep details, but UX goal: only show CITY as the chosen label.
    const admin = r.admin1 ? `, ${esc(r.admin1)}` : '';
    const country = r.country ? `, ${esc(r.country)}` : '';
    let meta = `${admin}${country}`;
    if (meta.startsWith(', ')) meta = meta.slice(2);

    const active = idx === _cityActiveIndex ? ' active' : '';
    return `<div class="item${active}" role="option" aria-selected="${idx === _cityActiveIndex}" data-idx="${idx}">
      <div class="name">${name}</div>
      <div class="meta">${meta}</div>
    </div>`;
  }).join('');

  els.cityResults.style.display = 'block';
  if (els.cityInput) els.cityInput.setAttribute('aria-expanded', 'true');
}

async function searchCities(q) {
  const reqSeq = ++_citySearchSeq;
  _activeCitySearchSeq = reqSeq;
  const isCurrent = () => reqSeq === _activeCitySearchSeq;

  const query = (q || '').trim();
  if (query.length < 2) return hideCityResults();
  if (query === _lastCityQuery) return;
  _lastCityQuery = query;

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`;
  try {
    const res = await fetch(url);
    if (!isCurrent()) return;
    if (!res.ok) throw new Error('geocoding failed');
    const data = await res.json();
    if (!isCurrent()) return;
    _lastCityResults = data?.results || [];
    _cityActiveIndex = -1;
    renderCityResults(_lastCityResults);
  } catch {
    if (!isCurrent()) return;
    hideCityResults();
  }
}

function chooseCityResult(r) {
  if (!r) return;
  // UX requirement: show just the city name (no country) in the pill + input.
  const label = `${r.name || ''}`.trim() || '—';
  setLocation(r.latitude, r.longitude, label);
  hideCityResults();
  // Not forced: use cache first; user can hit Refresh to force.
  fetchDay(false);
}

if (els.cityInput) {
  els.cityInput.addEventListener('input', (e) => {
    updateClearLocationButton();
    clearTimeout(_cityTimer);
    _cityTimer = setTimeout(() => searchCities(e.target.value), 220);
  });

  els.cityInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideCityResults(); return; }

    if (e.key === 'ArrowDown' && _lastCityResults.length) {
      e.preventDefault();
      _cityActiveIndex = clamp(_cityActiveIndex + 1, 0, _lastCityResults.length - 1);
      renderCityResults(_lastCityResults);
      return;
    }

    if (e.key === 'ArrowUp' && _lastCityResults.length) {
      e.preventDefault();
      _cityActiveIndex = clamp(_cityActiveIndex - 1, -1, _lastCityResults.length - 1);
      renderCityResults(_lastCityResults);
      return;
    }

    if (e.key === 'Enter' && _lastCityResults?.length) {
      e.preventDefault();
      const r = (_cityActiveIndex >= 0) ? _lastCityResults[_cityActiveIndex] : _lastCityResults[0];
      chooseCityResult(r);
    }
  });
}

if (els.btnClearLocation) {
  els.btnClearLocation.addEventListener('click', () => {
    if (!els.cityInput) return;
    els.cityInput.value = '';
    hideCityResults();
    updateClearLocationButton();
    els.cityInput.focus();
    els.cityInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

if (els.cityResults) {
  // pointerdown works better on mobile than mousedown (less delayed, more reliable)
  els.cityResults.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const idx = Number(item.getAttribute('data-idx'));
    const r = _lastCityResults[idx];
    chooseCityResult(r);
  });
}

document.addEventListener('click', (e) => {
  if (!els.cityResults || !els.cityInput) return;
  if (e.target === els.cityInput || els.cityResults.contains(e.target)) return;
  hideCityResults();
});

// ===== Cache =====
function cacheKey(lat, lon, threshold, { days = 2, model = 'ray', mode = 'full' } = {}) {
  const rlat = Number(lat).toFixed(COORD_CACHE_KEY_DECIMALS);
  const rlon = Number(lon).toFixed(COORD_CACHE_KEY_DECIMALS);
  const thr = Number(threshold);
  return `iwannasun_day_${rlat}_${rlon}_${thr}_d${days}_m${model}_mo${mode}`;
}

function loadCached(lat, lon, threshold, maxAgeMs = 5 * 60 * 1000, opts = {}) {
  try {
    const key = cacheKey(lat, lon, threshold, opts);
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.ts || !obj.data) return null;
    if (Date.now() - obj.ts > maxAgeMs) return null;
    return obj.data;
  } catch {
    return null;
  }
}

function clearCached(lat, lon, threshold, opts = {}) {
  try {
    sessionStorage.removeItem(cacheKey(lat, lon, threshold, opts));
  } catch {
    // ignore privacy mode / quota behavior
  }
}

function saveCached(lat, lon, threshold, data, opts = {}) {
  try {
    const key = cacheKey(lat, lon, threshold, opts);
    sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // ignore quota / privacy mode
  }
}

// ===== API =====
function buildDayUrls(lat, lon, threshold, days, mode) {
  const base = `${API_BASE}/day?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
    + `&threshold=${encodeURIComponent(threshold)}&days=${days}&mode=${encodeURIComponent(mode)}`;
  return {
    urlRay: base + `&model=ray`,
    urlLocal: base + `&model=local`,
  };
}

function applyForecastPayload(data, {
  usedModel = '',
  fallbackFromRay = false,
  fallbackReason = '',
} = {}) {
  state.data = data;
  state.tzName = data?.meta?.tz_name || null;
  state.geometryMode = String(data?.model || usedModel || '').toLowerCase() || null;
  state.rayFallbackActive = Boolean(fallbackFromRay && state.geometryMode === 'local');
  state.rayFallbackReason = state.rayFallbackActive ? String(fallbackReason || '') : '';
  prepData(state.data);
}

async function fetchDay(force = false) {
  const reqSeq = ++_fetchDaySeq;
  _activeFetchDaySeq = reqSeq;
  const isCurrent = () => reqSeq === _activeFetchDaySeq;

  // Respect cooldown (even if user spams Refresh)
  // IMPORTANT: if we return early, make sure we aren't leaving the UI in a busy state.
  if (rateLimitRemainingMs() > 0) {
    if (isCurrent()) {
      applyRateLimitUi();
      setBusy(false);
    }
    return;
  }

  setBusy(true);
  await nextPaint();
  if (!isCurrent()) return;
  clearError();

  const lat = state.lat;
  const lon = state.lon;
  if (lat == null || lon == null) {
    if (isCurrent()) {
      if (!state.data) clearForecastUi();
      showError('No location set');
      setBusy(false);
    }
    return;
  }

  const threshold = DEFAULT_THRESHOLD;
  const wantedMode = 'full';

  const { urlRay, urlLocal } = buildDayUrls(lat, lon, threshold, DAYS, wantedMode);

  if (!force) {
    const cacheOptions = [
      { days: DAYS, model: 'ray', mode: wantedMode },
      { days: DAYS, model: 'local', mode: wantedMode },
    ];
    for (const cacheOpts of cacheOptions) {
      const cached = loadCached(lat, lon, threshold, 5 * 60 * 1000, cacheOpts);
      if (!cached) continue;

      let normalizedCached = null;
      try {
        normalizedCached = normalizeForecastPayload(cached);
      } catch (e) {
        if (!(e instanceof ForecastNormalizationError)) throw e;
        clearCached(lat, lon, threshold, cacheOpts);
        console.warn('IWS_MALFORMED_CACHED_FORECAST', e);
        continue;
      }

      if (!isCurrent()) return;
      applyForecastPayload(normalizedCached, {
        usedModel: cacheOpts.model,
        fallbackFromRay: cacheOpts.model === 'local',
        fallbackReason: 'Using local geometry fallback (ray unavailable on last successful fetch).',
      });
      render();
      if (isCurrent()) setBusy(false);
      return;
    }
  }

  try {
    if (_dayAbort) _dayAbort.abort();
    _dayAbort = new AbortController();
    const { signal } = _dayAbort;

    let usedModel = 'ray';
    let fallbackFromRay = false;
    let fallbackStatus = null;
    let fallbackErrorCode = '';
    let res = await fetch(urlRay, { signal });
    if (!isCurrent()) return;

    if (!res.ok) {
      let msg = '';
      try {
        const errBody = await res.json();
        msg = (typeof errBody?.detail === 'string') ? errBody.detail : '';
      } catch {}
      const errCode = (res.headers?.get?.('X-IWS-Error-Code') || '').trim();
      fallbackStatus = Number(res.status);
      fallbackErrorCode = String(errCode || '');

      // Provider rate limit (Open-Meteo). Backend returns 503 and should include Retry-After.
      if (res.status === 503 && (errCode === 'UPSTREAM_RATE_LIMIT' || msg.toLowerCase().includes('rate limit'))) {
        if (isCurrent()) {
          handleCooldownResponse(res, RL_PROVIDER_DEFAULT_COOLDOWN_S, 15 * 60, 'Rate limited by forecast provider. Please wait.');
        }
        return;
      }

      // Your API limiter (user spamming). Backend returns 429 and should include Retry-After.
      if (res.status === 429) {
        if (isCurrent()) {
          handleCooldownResponse(res, RL_USER_DEFAULT_COOLDOWN_S, 60, 'Slow down, too many requests to our service.');
        }
        return;
      }

      // Otherwise: fall back to local model if ray failed for non-rate-limit reasons.
      fallbackFromRay = true;
      usedModel = 'local';
      res = await fetch(urlLocal, { signal });
      if (!isCurrent()) return;
    }

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const j = await res.json();
        if (typeof j?.detail === 'string') msg = j.detail;
      } catch {}
      if (isCurrent()) {
        if (!state.data) clearForecastUi();
        showError(msg);
      }
      return;
    }

    const rawData = await res.json();
    if (!isCurrent()) return;
    const data = normalizeForecastPayload(rawData);
    applyForecastPayload(data, {
      usedModel,
      fallbackFromRay,
      fallbackReason: 'Using local geometry fallback (ray request failed).',
    });
    if (state.rayFallbackActive) {
      console.info('IWS_MODEL_FALLBACK', {
        from: 'ray',
        to: 'local',
        status: fallbackStatus,
        error_code: fallbackErrorCode || null,
      });
    }

    saveCached(lat, lon, threshold, rawData, { days: DAYS, model: usedModel, mode: wantedMode });
    render();
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 20)) return;
    if (isCurrent()) {
      if (!state.data) clearForecastUi();
      showError(
        e instanceof ForecastNormalizationError
          ? 'Received malformed forecast data. Please try again.'
          : 'Network error (could not reach API).'
      );
    }
    console.error(e);
  } finally {
    if (isCurrent()) setBusy(false);
  }
}

// ===== Rendering =====
function setMeter(fillEl, pct, color) {
  if (!fillEl) return;
  const p = clamp(Number(pct || 0), 0, 100);
  fillEl.style.width = `${p}%`;
  fillEl.style.background = color || 'rgba(51,51,51,0.22)';
}

function sunQualityFromScore(score, isNight) {
  if (isNight) {
    return {
      label: 'No sun',
      emoji: '🌙',
      support: 'Sun is below the horizon.',
    };
  }

  const s = clamp(Number(score || 0), 0, 100);
  if (s <= 20) {
    return {
      label: 'Very weak sun',
      emoji: '☁️',
      support: 'Sunlight is mostly blocked right now.',
    };
  }
  if (s <= 40) {
    return {
      label: 'Weak sun',
      emoji: '🌥️',
      support: 'Only brief or faint sunlight possible.',
    };
  }
  if (s <= 60) {
    return {
      label: 'Limited sun',
      emoji: '⛅',
      support: 'Sunlight is faint or appears briefly.',
    };
  }
  if (s <= 80) {
    return {
      label: 'Good sun',
      emoji: '🌤️',
      support: 'Sunlight is mostly clear, but slightly faint or briefly blocked.',
    };
  }
  return {
    label: 'Excellent sun',
    emoji: '☀️',
    support: 'Strong, uninterrupted sunlight.',
  };
}

function sunQualityFromScoreTomorrow(score, isNight) {
  if (isNight) {
    return {
      label: 'No sun',
      emoji: '🌙',
      support: 'The sun stays below the horizon tomorrow.',
    };
  }

  const s = clamp(Number(score || 0), 0, 100);
  if (s <= 20) {
    return {
      label: 'Very weak sun',
      emoji: '☁️',
      support: 'Direct sunlight looks limited for most of tomorrow.',
    };
  }
  if (s <= 40) {
    return {
      label: 'Weak sun',
      emoji: '🌥️',
      support: 'Only brief or faint sunlight for most of tomorrow.',
    };
  }
  if (s <= 60) {
    return {
      label: 'Limited sun',
      emoji: '⛅',
      support: 'Sunlight is faint or appears briefly tomorrow.',
    };
  }
  if (s <= 80) {
    return {
      label: 'Good sun',
      emoji: '🌤️',
      support: 'Sunlight is mostly clear for much of tomorrow, but slightly faint.',
    };
  }
  return {
    label: 'Excellent sun',
    emoji: '☀️',
    support: 'Strong sunlight for most of tomorrow.',
  };
}

function renderDecision(focusRow, context = { label: 'now' }) {
  if (!focusRow) {
    if (els.decisionText) els.decisionText.textContent = '—';
    if (els.scoreNow) els.scoreNow.textContent = '—';
    if (els.confNow) els.confNow.textContent = '—';
    if (els.decisionLead) els.decisionLead.textContent = '';
    if (els.decisionContext) els.decisionContext.textContent = '';
    if (els.whyInline) els.whyInline.textContent = '';
    setMeter(els.meterScore, 0, 'rgba(51,51,51,0.10)');
    setMeter(els.meterConf, 0, 'rgba(51,51,51,0.10)');
    return;
  }

  const label = String(context?.label || '');
  const isNow = label === 'now';
  const isTomorrow = label.toLowerCase().startsWith('tomorrow');
  const isAvg = label.toLowerCase().includes('average');
  if (els.labelScore) els.labelScore.textContent = isNow ? 'Sun score now' : (isAvg ? 'Sun score (avg)' : 'Sun score');
  // Confidence label text adjusts depending on context (now vs average)
  if (els.labelConf) setLabelLeadText(els.labelConf, isNow ? 'Confidence now ' : (isAvg ? 'Confidence (avg) ' : 'Confidence '));

  const s = Number(focusRow.sun_score || 0);
  const c = Number(focusRow.confidence || 0);
  const chartMaxElevation = Number(context?.chartMaxElevation);
  const isNightByRow = Number(focusRow.elevation || 0) <= 0;
  // Today: hard below-horizon override from current/nearest-now row.
  // Tomorrow: keep day-level guard from chart dataset.
  const isNight = isTomorrow
    ? (Number.isFinite(chartMaxElevation) ? (chartMaxElevation <= 0) : isNightByRow)
    : isNightByRow;

  if (els.scoreNow) els.scoreNow.textContent = Math.round(s) + '%';
  const sunT = clamp(s / 100, 0, 1);
  const sunColor = mixSunColor(sunT, 1);

  setMeter(els.meterScore, Math.round(s), sunColor);

  if (!isDaylightRow(focusRow)) {
    if (els.confNow) {
      els.confNow.textContent = '—';
      els.confNow.title = 'Sun below horizon (confidence not applicable).';
    }
    setMeter(els.meterConf, 0, 'rgba(51,51,51,0.10)');
  } else {
    const cp = Math.round(c * 100);
    if (els.confNow) {
      els.confNow.textContent = cp + '%';
      els.confNow.title = isAvg
        ? 'Confidence average across daylight hours (higher = more stable conditions).'
        : 'Confidence = how reliable the sun score estimate is (higher = more stable conditions).';
    }
    // Confidence uses a neutral ink color (not the sunny color) so it feels distinct
    setMeter(els.meterConf, cp, 'rgba(51,51,51,0.28)');
  }

  const quality = isTomorrow
    ? sunQualityFromScoreTomorrow(s, isNight)
    : sunQualityFromScore(s, isNight);

  if (els.decisionText) els.decisionText.textContent = `${quality.label} ${quality.emoji}`;
  if (els.decisionWrap) {
    const neutralDecisionColor = (els.decisionContext && window.getComputedStyle)
      ? window.getComputedStyle(els.decisionContext).color
      : '';
    els.decisionWrap.classList.add('big');
    els.decisionWrap.style.color = isNight
      ? (neutralDecisionColor || 'var(--muted)')
      : sunColor;
  }

  if (els.decisionLead) {
    els.decisionLead.textContent = isTomorrow ? 'Based on daylight sun score average.' : '';
  }

  // Primary support line: deterministic by horizon/score band only.
  if (els.decisionContext) els.decisionContext.textContent = quality.support;

  // Secondary line: context + rain modifier (rain is secondary only).
  if (els.whyInline) {
    const secondary = [];
    if (Number(focusRow.cloud?.precip_mm ?? 0) > 0.2) {
      secondary.push('Rain may reduce direct sunlight.');
    }
    els.whyInline.textContent = secondary.join(' ');
    els.whyInline.classList.toggle('secondaryLine', secondary.length > 0);
  }
}

function renderNextWindow(win, opts = {}) {
  if (!els.nextWindow || !els.nextWindowSub) return;
  if (els.nextWindowHeading && typeof opts.heading === 'string' && opts.heading.trim()) {
    els.nextWindowHeading.textContent = opts.heading;
  }

  if (!win) {
    els.nextWindow.textContent = 'No sunny window';
    els.nextWindow.classList.add('big');
    els.nextWindow.classList.remove('good');
    els.nextWindow.classList.add('bad');
    els.nextWindowSub.textContent = opts.emptySub || 'Try again later.';
    return;
  }

  const a = fmtTime(win.start);
  const b = fmtTime(win.end);
  const mins = (win.minutes != null)
    ? win.minutes
    : Math.max(0, Math.round((new Date(win.end) - new Date(win.start)) / 60000));

  if (opts.activeNow) {
    els.nextWindow.textContent = `Until ${b}`;
  } else {
    els.nextWindow.textContent = `${a} – ${b}`;
  }
  els.nextWindow.classList.add('big');
  els.nextWindow.classList.remove('bad');
  els.nextWindow.classList.add('good');

  if (opts.subLabel) {
    els.nextWindowSub.textContent = opts.subLabel;
    return;
  }

  if (opts.activeNow) {
    const rem = Math.max(0, Math.round((new Date(win.end).getTime() - Date.now()) / 60000));
    els.nextWindowSub.textContent = `${rem} minutes likely remaining`;
  } else {
    els.nextWindowSub.textContent = `${mins} minutes above threshold`;
  }
}

function renderTimeline(visibleRows) {
  if (!els.timeline) return;

  const parts = [];
  parts.push(
    '<div class="trow trowHead muted small">'
      + '<div>Time</div><div title="Confidence">Conf.</div><div>Sun score</div></div>'
  );

  for (const r of (visibleRows || [])) {
    const dt = tUtc(r);
    const t = fmtTime(dt);
    const s = Math.round(Number(r.sun_score || 0));
    const c = isDaylightRow(r) ? Math.round(Number(r.confidence || 0) * 100) : null;

    const tcol = clamp(s / 100, 0, 1);
    const w = clamp(s, 0, 100);
    const op = (0.25 + 0.75 * tcol).toFixed(3);
    const color = mixSunColor(tcol, 1);
    const grad = `linear-gradient(90deg, ${mixSunColor(0, 0.6)}, ${color})`;

    parts.push(
      '<div class="trow">'
        + `<div class="muted">${t}</div>`
        + `<div class="muted" title="Confidence in prediction">${c == null ? '—' : (c + '%')}</div>`
        + '<div>'
        + `<div class="scoreNum" style="color:${color}">${s}%</div>`
        + '<div class="bar"><div style="width:' + w + '%;background:' + grad + ';opacity:' + op + '"></div></div>'
        + '</div>'
        + '</div>'
    );
  }

  els.timeline.innerHTML = parts.join('');
}

function renderChart(dayRows, win = null, rowsOverride = null) {
  if (!els.canvas || !ctx) return;

  // Use rect sizing (more reliable on mobile than clientWidth during reflow)
  const rect = els.canvas.getBoundingClientRect();
  const cssW = Math.max(1, Math.round(rect.width || els.canvas.clientWidth || 0));
  const cssH = Math.max(1, Math.round(rect.height || els.canvas.clientHeight || 0));
  if (cssW <= 1 || cssH <= 1) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (els.canvas.width !== targetW || els.canvas.height !== targetH) {
    els.canvas.width = targetW;
    els.canvas.height = targetH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = cssW;
  const h = cssH;

  ctx.clearRect(0, 0, w, h);

  if (!dayRows || !dayRows.length) {
    _chartGeom = null;
    _chartAxisKey = '';
    if (els.yAxis) els.yAxis.innerHTML = '';
    if (els.xAxis) els.xAxis.innerHTML = '';
    return;
  }

  win = win || daylightWindow(dayRows, 30);
  if (!win) {
    _chartGeom = null;
    _chartAxisKey = '';
    if (els.yAxis) els.yAxis.innerHTML = '';
    if (els.xAxis) els.xAxis.innerHTML = '';
    return;
  }

  const rows = rowsOverride || chartRowsForWindow(dayRows, win);
  if (!rows.length) {
    _chartGeom = null;
    _chartAxisKey = '';
    if (els.yAxis) els.yAxis.innerHTML = '';
    if (els.xAxis) els.xAxis.innerHTML = '';
    return;
  }

  const elevs = rows.map(r => Math.max(0, Number(r.elevation || 0)));
  const maxElevRaw = Math.max(...elevs, 1);
  const maxElev = Math.max(10, Math.ceil(maxElevRaw / 10) * 10);
  const axisKey = chartAxisKeyForRows(rows, state.tzName, maxElev);

  if (els.yAxis && axisKey !== _chartAxisKey) {
    const ticks = [];
    for (let d = maxElev; d >= 0; d -= 10) ticks.push(d);
    els.yAxis.innerHTML = ticks.map(d => `<div>${d}°</div>`).join('');
  }

  if (els.xAxis && axisKey !== _chartAxisKey) {
    const t0 = tUtc(rows[0]);
    const t1 = tUtc(rows[rows.length - 1]);
    const steps = 4;
    const labels = [];
    for (let k = 0; k <= steps; k++) {
      const tt = new Date(t0.getTime() + (k / steps) * (t1 - t0));
      const mins = tt.getMinutes();
      const roundedMins = Math.round(mins / 10) * 10;
      tt.setMinutes(roundedMins, 0, 0);
      labels.push(fmtTime(tt));
    }
    if (labels.length) {
      labels[0] = fmtTime(t0);
      labels[labels.length - 1] = fmtTime(t1);
    }
    els.xAxis.innerHTML = labels.map(t => `<div>${t}</div>`).join('');
  }
  _chartAxisKey = axisKey;

  const padX = 14;
  const padTop = 14;
  const padBottom = 18;
  const lightAtmosphere = Boolean(document.body && !document.body.classList.contains('solarApiPage'));
  const gridStroke = lightAtmosphere ? 'rgba(20,24,28,0.12)' : 'rgba(0,0,0,0.10)';
  const baseStroke = lightAtmosphere ? 'rgba(20,24,28,0.28)' : 'rgba(0,0,0,0.26)';
  const nowStroke = lightAtmosphere ? 'rgba(20,24,28,0.24)' : 'rgba(0,0,0,0.22)';

  const yOf = (e) => {
    const usableH = h - padTop - padBottom;
    const yy = (h - padBottom) - (e / maxElev) * usableH;
    return clamp(yy, padTop, h - padBottom);
  };
  const xOf = (i) => rows.length === 1 ? w / 2 : padX + (i / (rows.length - 1)) * (w - 2 * padX);

  // grid lines
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = gridStroke;
  for (let d = 0; d <= maxElev; d += 10) {
    const y = yOf(d);
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(w - padX, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const pts = rows.map((r, i) => {
    const e = Math.max(0, Number(r.elevation || 0));
    return { x: xOf(i), y: yOf(e), e, s: Number(r.sun_score || 0), t: tUtc(r) };
  });

  _chartGeom = { w, padX, ptsLen: pts.length };

  // soft fill based on average score
  const avgScore = pts.reduce((acc, p) => acc + p.s, 0) / Math.max(1, pts.length);
  const tAvg = clamp(avgScore / 100, 0, 1);
  const fillAlpha = 0.03 + 0.11 * tAvg;

  const fillGrad = ctx.createLinearGradient(0, padTop, 0, h);
  fillGrad.addColorStop(0, mixSunColor(tAvg, fillAlpha));
  fillGrad.addColorStop(0.58, mixSunColor(tAvg, fillAlpha * 0.44));
  fillGrad.addColorStop(1, mixSunColor(tAvg, 0));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, h - padBottom);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.lineTo(pts[pts.length - 1].x, h - padBottom);
  ctx.closePath();
  ctx.fillStyle = fillGrad;
  ctx.fill();

  const atmosphereGrad = ctx.createLinearGradient(0, padTop, 0, h - padBottom);
  if (lightAtmosphere) {
    atmosphereGrad.addColorStop(0, 'rgba(255,248,236,0.10)');
    atmosphereGrad.addColorStop(0.42, 'rgba(255,255,255,0.03)');
    atmosphereGrad.addColorStop(1, 'rgba(255,255,255,0.00)');
  } else {
    atmosphereGrad.addColorStop(0, 'rgba(255, 248, 236, 0.06)');
    atmosphereGrad.addColorStop(0.42, 'rgba(255, 255, 255, 0.015)');
    atmosphereGrad.addColorStop(1, 'rgba(255, 255, 255, 0.00)');
  }
  ctx.fillStyle = atmosphereGrad;
  ctx.fill();

  // base line
  ctx.lineWidth = 2.3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
    else ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.strokeStyle = baseStroke;
  ctx.stroke();

  // score intensity strokes
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.e <= 0 || b.e <= 0) continue;

    const t = clamp(((a.s + b.s) / 2) / 100, 0, 1);
    const elev = (a.e + b.e) / 2;

    const thinNearHorizon = 0.55 + 0.45 * clamp(elev / 6, 0, 1);
    const lw = (0.7 + 6.5 * (t ** 1.3)) * thinNearHorizon;
    const glowFade = clamp(elev / 8, 0, 1);
    const glowStrength = (0.08 + 0.40 * (t ** 1.4)) * glowFade;
    const glowBlur = 4 + 16 * (t ** 1.6);

    ctx.save();
    ctx.globalAlpha = glowStrength;
    ctx.lineWidth = lw + 6;
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = mixSunColor(t, 0.9);
    ctx.strokeStyle = mixSunColor(t, 1);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.10 + 0.90 * (t ** 1.08);
    ctx.lineWidth = lw;
    ctx.strokeStyle = mixSunColor(t, 1);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  // "now" vertical line
  const now = Date.now();
  const t0ms = pts[0].t.getTime();
  const t1ms = pts[pts.length - 1].t.getTime();
  if (now >= t0ms && now <= t1ms) {
    const u = clamp((now - t0ms) / Math.max(1, (t1ms - t0ms)), 0, 1);
    const xn = padX + u * (w - 2 * padX);

    ctx.strokeStyle = nowStroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(xn, padTop);
    ctx.lineTo(xn, h - padBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    const idx = Math.round(u * (pts.length - 1));
    const p = pts[clamp(idx, 0, pts.length - 1)];

    // subtle warm halo to make "now" feel intentional without adding visual weight
    ctx.fillStyle = 'rgba(244,184,96,0.24)';
    ctx.beginPath();
    ctx.arc(xn, p.y, 5, 0, Math.PI * 2);
    ctx.fill();

    // higher-contrast core so marker remains visible over bright curve segments
    ctx.fillStyle = lightAtmosphere ? 'rgba(120,72,20,0.96)' : 'rgba(255,244,226,0.95)';
    ctx.beginPath();
    ctx.arc(xn, p.y, 2.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = lightAtmosphere ? 'rgba(120,72,20,0.62)' : 'rgba(255,248,232,0.92)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(xn, p.y, 2.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // hover inspector (pointer devices): guide line + point + small tooltip
  if (_chartHover.active && _chartHover.idx >= 0 && _chartHover.idx < pts.length) {
    const hp = pts[_chartHover.idx];
    const t = clamp(Number(hp.s || 0) / 100, 0, 1);
    const dotColor = mixSunColor(t, 1);
    const label = `${fmtTime(hp.t)} · ${Math.round(hp.s)}%`;

    ctx.save();

    ctx.strokeStyle = 'rgba(20,24,28,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(hp.x, padTop);
    ctx.lineTo(hp.x, h - padBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255,255,255,0.90)';
    ctx.beginPath();
    ctx.arc(hp.x, hp.y, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(hp.x, hp.y, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '600 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
    ctx.textBaseline = 'middle';
    const txPad = 7;
    const tipH = 20;
    const tipW = Math.ceil(ctx.measureText(label).width) + txPad * 2;
    const tipY = padTop + 5;
    let tipX = Math.round(hp.x - tipW / 2);
    tipX = clamp(tipX, padX + 2, w - padX - tipW - 2);

    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.strokeStyle = 'rgba(20,24,28,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(tipX, tipY, tipW, tipH);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(20,24,28,0.82)';
    ctx.fillText(label, tipX + txPad, tipY + tipH / 2);
    ctx.restore();
  }
}

function currentDayIndex() {
  return Number(els.daySelect?.value || 0);
}

function ensurePreparedDays() {
  const dayIndex = currentDayIndex();
  let dayRows = (state.days && state.days[dayIndex]) ? state.days[dayIndex] : null;
  if (!dayRows) {
    prepData(state.data);
  }
}

function getCurrentForecastRenderState(nowMs = Date.now()) {
  if (!state.data) return null;
  ensurePreparedDays();
  return deriveForecastRenderState({
    data: state.data,
    days: state.days,
    dayIndex: currentDayIndex(),
    nowMs,
  });
}

function redrawChartOnly(nowMs = Date.now()) {
  const renderState = getCurrentForecastRenderState(nowMs);
  if (!renderState) return false;
  renderChart(renderState.chart.dayRows, renderState.chart.dayWin30, renderState.chart.chartRows);
  return true;
}

function updateTimePill() {
  if (!els.timePill) return;
  if (state.tzName) {
    els.timePill.textContent = fmtTime(new Date());
    els.timePill.title = `Local time (${state.tzName})`;
  } else {
    els.timePill.textContent = '—';
    els.timePill.title = '';
  }
}

function renderSunriseSunset(dayWin) {
  if (!els.sunriseTime || !els.sunsetTime) return;
  if (!dayWin) {
    els.sunriseTime.textContent = '—';
    els.sunsetTime.textContent = '—';
    els.sunriseTime.title = 'No sunrise (sun stays below horizon)';
    els.sunsetTime.title = 'No sunset (sun stays below horizon)';
    return;
  }
  els.sunriseTime.textContent = fmtTime(dayWin.start);
  els.sunsetTime.textContent = fmtTime(dayWin.end);
  els.sunriseTime.title = fmtDateTime(dayWin.start);
  els.sunsetTime.title = fmtDateTime(dayWin.end);
}

function renderTimelineState(timelineState) {
  if (!els.timeline) return;
  if (!timelineState?.hasDaylightAhead) {
    els.timeline.style.display = 'none';
    els.timeline.innerHTML = '';
    return;
  }
  els.timeline.style.display = 'block';
  renderTimeline(timelineState.visibleRows);
}

function renderModelModeNote() {
  if (!els.modelModeNote) return;
  if (state.rayFallbackActive) {
    els.modelModeNote.style.display = 'block';
    els.modelModeNote.textContent = state.rayFallbackReason;
  } else {
    els.modelModeNote.style.display = 'none';
    els.modelModeNote.textContent = '';
  }
}

function rowSnapshotKey(row) {
  if (!row) return 'null';
  return [
    row.time_utc || '',
    Number(row.sun_score || 0),
    Number(row.confidence || 0),
    Number(row.elevation || 0),
    row.is_daylight ? 1 : 0,
    row._themeFallback ? 1 : 0,
    Number(row.cloud?.precip_mm || 0),
  ].join('|');
}

function windowSnapshotKey(win) {
  if (!win) return 'null';
  return [
    win.start || '',
    win.end || '',
    Number(win.minutes || 0),
  ].join('|');
}

function rowsSnapshotKey(rows) {
  return (rows || []).map((row) => rowSnapshotKey(row)).join('||');
}

function chartAxisKeyForRows(rows, tzName = state.tzName, maxElevOverride = null) {
  const chartRows = rows || [];
  if (!chartRows.length) return '';

  let maxElev = maxElevOverride;
  if (!Number.isFinite(maxElev)) {
    maxElev = maxElevationFromRows(chartRows);
  }
  const axisMaxElev = Math.max(10, Math.ceil(Math.max(1, Number(maxElev || 0)) / 10) * 10);
  return [
    tzName || '',
    axisMaxElev,
    chartRows.length,
    chartRows[0]?.time_utc || '',
    chartRows[chartRows.length - 1]?.time_utc || '',
  ].join('|');
}

function buildRenderSnapshot(renderState, nowMs = Date.now()) {
  const activeRemainingMinutes = renderState.sideCard?.opts?.activeNow && renderState.sideCard?.win
    ? Math.max(0, Math.round((new Date(renderState.sideCard.win.end).getTime() - nowMs) / 60000))
    : null;
  return {
    decisionKey: [
      renderState.decision.contextLabel,
      Number(renderState.decision.chartMaxElevation || 0),
      rowSnapshotKey(renderState.decision.decisionRow),
    ].join('|'),
    themeKey: [
      rowSnapshotKey(renderState.theme.themeRow),
      renderState.theme.twilightContext?.sunrise?.toISOString?.() || '',
      renderState.theme.twilightContext?.sunset?.toISOString?.() || '',
    ].join('|'),
    sideCardKey: [
      renderState.sideCard.mode,
      windowSnapshotKey(renderState.sideCard.win),
      renderState.sideCard.opts?.heading || '',
      renderState.sideCard.opts?.emptySub || '',
      renderState.sideCard.opts?.activeNow ? 1 : 0,
      activeRemainingMinutes == null ? '' : activeRemainingMinutes,
    ].join('|'),
    sunriseSunsetKey: renderState.theme.dayWin
      ? `${renderState.theme.dayWin.start.toISOString()}|${renderState.theme.dayWin.end.toISOString()}`
      : 'none',
    timelineKey: [
      renderState.timeline.hasDaylightAhead ? 1 : 0,
      rowsSnapshotKey(renderState.timeline.visibleRows),
    ].join('|'),
    chartDataKey: rowsSnapshotKey(renderState.chart.chartRows),
    chartAxisKey: chartAxisKeyForRows(renderState.chart.chartRows),
  };
}

function computeRenderPlan(snapshot, prevSnapshot = null, {
  full = false,
  includeRateLimitUi = false,
  includeModelModeNote = false,
} = {}) {
  return {
    updateTimePill: true,
    updateDecision: full || snapshot.decisionKey !== prevSnapshot?.decisionKey,
    updateTheme: full || snapshot.themeKey !== prevSnapshot?.themeKey,
    updateSideCard: full || snapshot.sideCardKey !== prevSnapshot?.sideCardKey,
    updateSunriseSunset: full || snapshot.sunriseSunsetKey !== prevSnapshot?.sunriseSunsetKey,
    redrawChart: true,
    updateTimeline: full || snapshot.timelineKey !== prevSnapshot?.timelineKey,
    updateRateLimitUi: includeRateLimitUi,
    updateModelModeNote: includeModelModeNote,
  };
}

function applyRenderState(renderState, snapshot, prevSnapshot = null, {
  full = false,
  includeRateLimitUi = false,
  includeModelModeNote = false,
} = {}) {
  const plan = computeRenderPlan(snapshot, prevSnapshot, {
    full,
    includeRateLimitUi,
    includeModelModeNote,
  });

  if (plan.updateTimePill) updateTimePill();

  if (plan.updateDecision) {
    renderDecision(renderState.decision.decisionRow, {
      label: renderState.decision.contextLabel,
      chartMaxElevation: renderState.decision.chartMaxElevation,
    });
  }

  if (plan.updateTheme) {
    applyAtmosphericTheme(renderState.theme.themeRow, renderState.theme.twilightContext);
  }

  if (plan.updateSideCard) {
    renderNextWindow(renderState.sideCard.win, renderState.sideCard.opts);
  }

  if (plan.updateSunriseSunset) {
    renderSunriseSunset(renderState.theme.dayWin);
  }

  if (plan.redrawChart) {
    renderChart(renderState.chart.dayRows, renderState.chart.dayWin30, renderState.chart.chartRows);
  }

  if (plan.updateTimeline) {
    renderTimelineState(renderState.timeline);
  }

  if (plan.updateRateLimitUi) applyRateLimitUi();
  if (plan.updateModelModeNote) renderModelModeNote();
}

function setSelectorTestTimezone(tzName = '') {
  state.tzName = String(tzName || '').trim() || null;
  _fmtCache.clear();
  _hourFmtCache.clear();
}

if (IWS_SELECTOR_TEST_MODE && typeof window !== 'undefined') {
  function setSelectorTestAppState({
    data = null,
    days = null,
    tzName = '',
    isBusy = false,
    dayIndex = 0,
  } = {}) {
    state.data = data;
    state.days = days;
    state.tzName = String(tzName || '').trim() || null;
    state.isBusy = Boolean(isBusy);
    if (els.daySelect) els.daySelect.value = String(dayIndex);
  }

  function resetSelectorTestRenderState() {
    _lastRenderSnapshot = null;
    _chartAxisKey = '';
    _chartGeom = null;
    _chartHover.active = false;
    _chartHover.idx = -1;
  }

  function getSelectorTestInternals() {
    return {
      lastRenderSnapshot: _lastRenderSnapshot ? { ..._lastRenderSnapshot } : null,
      chartAxisKey: _chartAxisKey,
      chartHover: { active: _chartHover.active, idx: _chartHover.idx },
      chartGeom: _chartGeom ? { ..._chartGeom } : null,
    };
  }

  function setSelectorTestChartHover({
    active = false,
    idx = -1,
    geom = undefined,
  } = {}) {
    _chartHover.active = Boolean(active);
    _chartHover.idx = _chartHover.active ? Number(idx) : -1;
    if (geom !== undefined) _chartGeom = geom;
  }

  window.IWS_SELECTOR_TEST_API = {
    deriveForecastRenderState,
    selectDecisionViewState,
    selectSideCardViewState,
    selectThemeViewState,
    selectChartViewState,
    selectTimelineViewState,
    visibleTimelineRows,
    meaningfulWindows,
    nearestRowToLocalHour,
    computeAtmosphericTheme,
    daylightWindow,
    localHourForDate,
    normalizeForecastPayload,
    normalizeTimelineRow,
    normalizeForecastWindow,
    bucketForecastRowsByDay,
    buildRenderSnapshot,
    computeRenderPlan,
    chartAxisKeyForRows,
    redrawChartOnly,
    render,
    refreshTimeSensitiveUi,
    setSelectorTestTimezone,
    setSelectorTestAppState,
    resetSelectorTestRenderState,
    getSelectorTestInternals,
    setSelectorTestChartHover,
  };
}

function render() {
  if (!state.data) {
    clearForecastUi();
    return;
  }
  const nowMs = Date.now();
  const renderState = getCurrentForecastRenderState(nowMs);
  if (!renderState) {
    clearForecastUi();
    return;
  }
  const snapshot = buildRenderSnapshot(renderState, nowMs);
  applyRenderState(renderState, snapshot, _lastRenderSnapshot, {
    full: true,
    includeRateLimitUi: true,
    includeModelModeNote: true,
  });
  _lastRenderSnapshot = snapshot;
  _lastUiMinute = Math.floor(nowMs / 60000);
}

function refreshTimeSensitiveUi(force = false) {
  if (!state.data || state.isBusy) return;
  const nowMs = Date.now();
  const m = Math.floor(nowMs / 60000);
  if (!force && _lastUiMinute === m) return;
  _lastUiMinute = m;

  const renderState = getCurrentForecastRenderState(nowMs);
  if (!renderState) return;
  const snapshot = buildRenderSnapshot(renderState, nowMs);
  applyRenderState(renderState, snapshot, _lastRenderSnapshot, {
    full: false,
    includeRateLimitUi: false,
    includeModelModeNote: false,
  });
  _lastRenderSnapshot = snapshot;
}

// ===== Actions =====
async function useHere({ silent = false } = {}) {
  setBusy(true);
  await nextPaint();

  if (!navigator.geolocation) {
    if (!silent) showError('Your browser doesn’t support location. Please search for a city.');
    setBusy(false);
    els.cityInput?.focus();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = roundCoord(pos.coords.latitude, COORD_STATE_DECIMALS);
      const lon = roundCoord(pos.coords.longitude, COORD_STATE_DECIMALS);
  
      // Immediate feedback
      setLocation(lat, lon, 'My location');
      const reverseGeocodeSeq = _locationSeq;
  
      // Start forecast ASAP (don't wait for city lookup)
      fetchDay(false);
  
      // Reverse geocode in background (update label when it arrives)
      (async () => {
        try {
          const url =
            `https://api.bigdatacloud.net/data/reverse-geocode-client` +
            `?latitude=${encodeURIComponent(lat)}` +
            `&longitude=${encodeURIComponent(lon)}` +
            `&localityLanguage=en`;
  
          const res = await fetch(url);
          if (!res.ok) return;
  
          const j = await res.json();
          const city =
            j.city ||
            j.locality ||
            j.principalSubdivision ||
            j.localityInfo?.administrative?.[0]?.name ||
            '';
  
          if (city) {
            if (reverseGeocodeSeq !== _locationSeq) return;
            if (state.lat !== lat || state.lon !== lon) return;
            // Only update label; keep the same lat/lon and don't clear state.data
            state.label = String(city).trim();
            if (els.cityInput) els.cityInput.value = state.label;
            updateClearLocationButton();
          }
        } catch {
          // ignore, keep "My location"
        }
      })();
    },
    () => {
      if (!silent) showError('Please allow location, or search for a city above.');
      setBusy(false);
      els.cityInput?.focus();
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ===== Events =====
if (els.btnHere) els.btnHere.addEventListener('click', () => useHere());
if (els.btnRefresh) els.btnRefresh.addEventListener('click', () => fetchDay(true));

if (els.daySelect) els.daySelect.addEventListener('change', async () => {
  if (!state.data) return;
  clearChartHover();

  // Switching day can change wrapping which changes canvas width.
  // Wait a paint so layout settles, then render.
  await nextPaint();
  renderSoon();
});

// Redraw on viewport/layout changes (mobile address bar + orientation changes)
const _onResize = debounce(() => {
  if (!state.data || state.isBusy) return;
  renderSoon();
}, 160);

window.addEventListener('resize', _onResize);
window.addEventListener('orientationchange', _onResize);

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', _onResize);
}

// If supported, observe the canvas size directly (robust against flex/grid changes)
let _chartRO = null;
try {
  if (window.ResizeObserver && els.canvas) {
    _chartRO = new ResizeObserver(() => {
      if (!state.data || state.isBusy) return;
      renderSoon();
    });
    _chartRO.observe(els.canvas);
  }
} catch { /* ignore */ }

if (els.canvas) {
  let touchPointerId = null;

  els.canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (!state.data || state.isBusy) return;
    touchPointerId = e.pointerId;
    try { els.canvas.setPointerCapture(e.pointerId); } catch {}
    updateChartHoverFromClientX(e.clientX);
  });

  els.canvas.addEventListener('pointermove', (e) => {
    if (!state.data || state.isBusy) return;

    if (e.pointerType === 'touch') {
      if (touchPointerId == null || e.pointerId !== touchPointerId) return;
      updateChartHoverFromClientX(e.clientX);
      return;
    }

    updateChartHoverFromClientX(e.clientX);
  });

  els.canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    if (touchPointerId != null && e.pointerId === touchPointerId) {
      touchPointerId = null;
      clearChartHover();
      try { els.canvas.releasePointerCapture(e.pointerId); } catch {}
    }
  });

  els.canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch') return;
    clearChartHover();
  });

  els.canvas.addEventListener('pointercancel', (e) => {
    if (e.pointerType === 'touch' && touchPointerId != null && e.pointerId === touchPointerId) {
      touchPointerId = null;
      clearChartHover();
      try { els.canvas.releasePointerCapture(e.pointerId); } catch {}
      return;
    }
    if (e.pointerType !== 'touch') clearChartHover();
  });
}

function initMobilePullToRefresh() {
  const mqMobile = window.matchMedia ? window.matchMedia('(max-width: 700px)') : null;
  const mqCoarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
  const hasTouch = () => (navigator.maxTouchPoints || 0) > 0;
  const isActiveContext = () => Boolean(
    mqMobile && mqMobile.matches && ((mqCoarse && mqCoarse.matches) || hasTouch())
  );
  if (!isActiveContext()) return;

  const indicator = document.createElement('div');
  indicator.className = 'ptrIndicator';
  indicator.textContent = 'Pull to refresh';
  document.body.appendChild(indicator);

  const THRESHOLD_PX = 72;
  const MAX_PULL_PX = 120;
  let activeTouchId = null;
  let startY = 0;
  let isPulling = false;
  let isArmed = false;
  let settleTimer = null;

  const setPullPx = (px) => {
    if (!document.body) return;
    document.body.style.setProperty('--ptr-pull', `${Math.round(Math.max(0, Number(px) || 0))}px`);
  };

  const beginSettling = () => {
    if (!document.body) return;
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    document.body.classList.remove('ptrPulling');
    document.body.classList.add('ptrSettling');
    setPullPx(0);
    settleTimer = window.setTimeout(() => {
      if (!document.body) return;
      document.body.classList.remove('ptrSettling');
      settleTimer = null;
    }, 200);
  };

  const hideIndicator = (settle = true) => {
    indicator.classList.remove('active', 'armed', 'loading');
    if (settle) beginSettling();
  };

  const canStart = (event) => {
    if (!isActiveContext()) return false;
    if (state.isBusy) return false;
    if ((window.scrollY || window.pageYOffset || 0) > 0) return false;
    if (event.target && event.target.closest && event.target.closest('#sunChart')) return false;
    return true;
  };

  const findTouchById = (touchList, id) => {
    for (let i = 0; i < touchList.length; i += 1) {
      const t = touchList[i];
      if (t.identifier === id) return t;
    }
    return null;
  };

  window.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (!canStart(e)) return;
    const t = e.touches[0];
    activeTouchId = t.identifier;
    startY = t.clientY;
    isPulling = true;
    isArmed = false;
    indicator.textContent = 'Pull to refresh';
    if (document.body) {
      document.body.classList.remove('ptrSettling');
      document.body.classList.remove('ptrPulling');
    }
    setPullPx(0);
    hideIndicator(false);
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!isPulling || activeTouchId == null) return;
    const t = findTouchById(e.touches, activeTouchId);
    if (!t) return;

    const pull = clamp(t.clientY - startY, 0, MAX_PULL_PX);
    if (pull <= 0) {
      hideIndicator(false);
      return;
    }

    if (e.cancelable) e.preventDefault();
    if (document.body) {
      document.body.classList.remove('ptrSettling');
      document.body.classList.add('ptrPulling');
    }
    setPullPx(pull);
    indicator.classList.add('active');
    isArmed = pull >= THRESHOLD_PX;
    indicator.classList.toggle('armed', isArmed);
    indicator.textContent = isArmed ? 'Release to refresh' : 'Pull to refresh';
  }, { passive: false });

  const endPull = (touchList) => {
    if (!isPulling || activeTouchId == null) return;
    if (findTouchById(touchList, activeTouchId)) return;

    const shouldRefresh = isArmed && !state.isBusy;
    isPulling = false;
    isArmed = false;
    activeTouchId = null;

    if (!shouldRefresh) {
      hideIndicator(true);
      return;
    }

    beginSettling();
    indicator.classList.remove('armed');
    indicator.classList.add('active', 'loading');
    indicator.textContent = 'Refreshing…';
    Promise.resolve(fetchDay(true)).finally(() => {
      setTimeout(() => hideIndicator(), 260);
    });
  };

  window.addEventListener('touchend', (e) => {
    endPull(e.touches);
  }, { passive: true });

  window.addEventListener('touchcancel', (e) => {
    endPull(e.touches);
  }, { passive: true });
}

if (!IWS_SELECTOR_TEST_MODE) initMobilePullToRefresh();

// Keep UI fresh (time pill + “now” marker)
let _uiTick = null;
let _lastUiMinute = null;

function uiRefresh() {
  refreshTimeSensitiveUi(false);
}

function startUiTick() {
  if (_uiTick) return;
  refreshTimeSensitiveUi(true);
  _uiTick = setInterval(uiRefresh, 15 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTimeSensitiveUi(true); });
  window.addEventListener('focus', () => refreshTimeSensitiveUi(true));
}

if (!IWS_SELECTOR_TEST_MODE) startUiTick();

function getPresetLocation() {
  const raw = window.IWS_PRESET_LOCATION;
  if (!raw || typeof raw !== 'object') return null;

  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return {
    lat,
    lon,
    label: String(raw.label || '').trim(),
  };
}

// ===== Init =====
window.addEventListener('DOMContentLoaded', () => {
  if (IWS_SELECTOR_TEST_MODE) return;
  updateClearLocationButton();
  clearForecastUi();
  loadRateLimitUntil();
  applyRateLimitUi();

  state.lat = null;
  state.lon = null;
  state.data = null;
  state.geometryMode = null;
  state.rayFallbackActive = false;
  state.rayFallbackReason = '';

  const preset = getPresetLocation();
  if (preset) {
    setLocation(preset.lat, preset.lon, preset.label);
    fetchDay(false);
    return;
  }

  useHere({ silent: false });
});
