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
const SUN_BREAK_THRESHOLD = 65;
const DAYS = 2;
const COORD_STATE_DECIMALS = 3;
const COORD_CACHE_KEY_DECIMALS = 3;
const MEANINGFUL_WINDOW_MINUTES = 20;
const SUN_BREAK_MINIMUM_MINUTES = 15;
const SHARE_NOTICE_DURATION_MS = 3000;
const SHARE_VIEW_LAT_PARAM = 'lat';
const SHARE_VIEW_LON_PARAM = 'lon';
const SHARE_VIEW_LABEL_PARAM = 'label';
const SHARE_VIEW_DAY_PARAM = 'day';

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
  btnShare: $('btnShare'),
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

let _lastRenderSnapshot = null;
let _chartAxisKey = '';
let locationController = null;
let interactionController = null;

// ===== Request control =====
let _dayAbort = null;
let _fetchDaySeq = 0;
let _activeFetchDaySeq = 0;
let _shareNoticeTimer = null;
let _shareNoticeEl = null;

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

const PUBLIC_RUNTIME_COLORS = Object.freeze({
  meterFillEmpty: 'var(--meter-fill-empty)',
  meterFillNeutral: 'var(--meter-fill-neutral)',
  meterFillStrong: 'var(--meter-fill-strong)',
});

const SUN_SCORE_RGB_STOPS = Object.freeze({
  mutedLow: Object.freeze({ r: 160, g: 162, b: 144 }),
  muted: Object.freeze({ r: 186, g: 176, b: 136 }),
  pale: Object.freeze({ r: 214, g: 190, b: 118 }),
  warm: Object.freeze({ r: 236, g: 176, b: 74 }),
  gold: Object.freeze({ r: 246, g: 186, b: 62 }),
});

function sunScoreRgb(t) {
  const u = clamp(Number(t || 0), 0, 1);
  // Shared score palette used by chart, title, timeline, and atmospheric source glow.
  const stops = SUN_SCORE_RGB_STOPS;

  if (u >= 0.9) return blendRgb(stops.warm, stops.gold, (u - 0.9) / 0.1);
  if (u >= 0.7) return blendRgb(stops.pale, stops.warm, (u - 0.7) / 0.2);
  if (u >= 0.5) return blendRgb(stops.muted, stops.pale, (u - 0.5) / 0.2);
  return blendRgb(stops.mutedLow, stops.muted, u / 0.5);
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

function updateClearLocationButton() {
  if (!locationController) return;
  locationController.updateClearLocationButton();
}

function clearChartHover() {
  if (!interactionController) return;
  interactionController.clearChartHover();
}

function setTimePillValue(text) {
  if (!els.timePill) return;
  const valueEl = els.timePill.querySelector('.localTimeValue');
  if (valueEl) {
    valueEl.textContent = String(text || '—');
    return;
  }
  els.timePill.textContent = String(text || '—');
}

function ensureShareNotice() {
  if (_shareNoticeEl && document.body?.contains(_shareNoticeEl)) return _shareNoticeEl;
  const el = document.createElement('div');
  el.className = 'shareNotice';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  _shareNoticeEl = el;
  return el;
}

function showShareNotice(message, {
  isError = false,
  durationMs = SHARE_NOTICE_DURATION_MS,
} = {}) {
  const el = ensureShareNotice();
  globalThis.clearTimeout(_shareNoticeTimer);
  el.textContent = String(message || '');
  el.classList.toggle('isError', Boolean(isError));
  el.classList.add('isVisible');
  _shareNoticeTimer = globalThis.setTimeout(() => {
    el.classList.remove('isVisible');
  }, Math.max(500, Number(durationMs || SHARE_NOTICE_DURATION_MS)));
}

function currentDayIndex() {
  return Number(els.daySelect?.value || 0);
}

function normalizedShareDayIndex(value = currentDayIndex()) {
  return clamp(Math.trunc(Number(value || 0)), 0, 1);
}

function normalizedShareLabel() {
  const label = String(state.label || '').trim();
  if (!label) return '';
  if (label.toLowerCase() === 'my location') return '';
  return label;
}

function hasMeaningfulShareLocation(lat = state.lat, lon = state.lon) {
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return false;
  if (latNum < -90 || latNum > 90 || lonNum < -180 || lonNum > 180) return false;
  if (latNum === 0 && lonNum === 0) return false;
  return true;
}

function buildShareUrl({
  lat = state.lat,
  lon = state.lon,
  label = normalizedShareLabel(),
  dayIndex = normalizedShareDayIndex(),
} = {}) {
  const url = new URL(window.location.href);
  url.search = '';

  if (hasMeaningfulShareLocation(lat, lon)) {
    const latNum = Number(lat);
    const lonNum = Number(lon);
    url.searchParams.set(SHARE_VIEW_LAT_PARAM, String(roundCoord(latNum, COORD_STATE_DECIMALS)));
    url.searchParams.set(SHARE_VIEW_LON_PARAM, String(roundCoord(lonNum, COORD_STATE_DECIMALS)));

    const safeLabel = String(label || '').trim();
    if (safeLabel) {
      url.searchParams.set(SHARE_VIEW_LABEL_PARAM, safeLabel);
    }

    if (dayIndex > 0) {
      url.searchParams.set(SHARE_VIEW_DAY_PARAM, String(dayIndex));
    }
  }

  return url.toString();
}

function syncShareableUrlState() {
  if (!window.history || typeof window.history.replaceState !== 'function') return;
  const nextUrl = buildShareUrl();
  if (nextUrl === window.location.href) return;
  window.history.replaceState({}, '', nextUrl);
}

function readViewStateFromUrl() {
  let url;
  try {
    url = new URL(window.location.href);
  } catch {
    return { dayIndex: 0, hasLocation: false };
  }

  const lat = Number(url.searchParams.get(SHARE_VIEW_LAT_PARAM));
  const lon = Number(url.searchParams.get(SHARE_VIEW_LON_PARAM));
  const label = String(url.searchParams.get(SHARE_VIEW_LABEL_PARAM) || '').trim();
  const dayIndex = normalizedShareDayIndex(url.searchParams.get(SHARE_VIEW_DAY_PARAM));
  const hasLocation = hasMeaningfulShareLocation(lat, lon);

  return {
    dayIndex,
    hasLocation,
    lat,
    lon,
    label,
  };
}

function shouldUseNativeShare() {
  const uaDataMobile = navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean'
    ? navigator.userAgentData.mobile
    : null;
  if (uaDataMobile != null) return uaDataMobile;

  const ua = String(navigator.userAgent || '');
  if (/Android|iPhone|iPod|Windows Phone|Mobile/i.test(ua)) return true;
  if (/iPad/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
  return false;
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

async function handleShareClick() {
  const shareUrl = buildShareUrl();
  const payload = {
    title: document.title,
    text: 'Check out the sun forecast here:',
    url: shareUrl,
  };

  if (shouldUseNativeShare() && navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(payload.url);
      showShareNotice('Link copied');
      return;
    }
  } catch {
    // Fall through to legacy copy path.
  }

  try {
    const input = document.createElement('input');
    input.value = payload.url;
    input.setAttribute('readonly', '');
    input.style.position = 'absolute';
    input.style.left = '-9999px';
    document.body.appendChild(input);
    input.select();
    input.setSelectionRange(0, input.value.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(input);
    if (copied) {
      showShareNotice('Link copied');
      return;
    }
  } catch {
    // No-op.
  }

  showShareNotice('Copy failed', { isError: true });
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
  if (interactionController) interactionController.reset();
  resetAtmosphericTheme();
  _lastRenderSnapshot = null;
  _chartAxisKey = '';

  if (els.timePill) {
    setTimePillValue('—');
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
  setMeter(els.meterScore, 0, PUBLIC_RUNTIME_COLORS.meterFillEmpty);
  setMeter(els.meterConf, 0, PUBLIC_RUNTIME_COLORS.meterFillEmpty);

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

// Format times in the location timezone
const _fmtCache = new Map();
const _hourFmtCache = new Map();
const TIME_FORMAT_LOCALE = 'en-GB';
function getFormatters() {
  const tz = state.tzName || '';
  if (_fmtCache.has(tz)) return _fmtCache.get(tz);

  const make = (opts) => {
    try { return new Intl.DateTimeFormat(TIME_FORMAT_LOCALE, tz ? { ...opts, timeZone: tz } : opts); }
    catch { return new Intl.DateTimeFormat(TIME_FORMAT_LOCALE, opts); }
  };

  const f = {
    hm: make({ hour: '2-digit', minute: '2-digit', hour12: false }),
    h: make({ hour: '2-digit', hour12: false }),
    full: make({
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
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
    f = new Intl.DateTimeFormat(TIME_FORMAT_LOCALE, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz || undefined,
    });
  } catch {
    f = new Intl.DateTimeFormat(TIME_FORMAT_LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
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

const forecastModel = window.IWSForecastModel;
if (!forecastModel) {
  throw new Error('IWS forecast model module failed to load.');
}
const chartRenderer = window.IWSRenderChart;
if (!chartRenderer) {
  throw new Error('IWS chart render module failed to load.');
}
const timelineRenderer = window.IWSRenderTimeline;
if (!timelineRenderer) {
  throw new Error('IWS timeline render module failed to load.');
}
const atmosphereTheme = window.IWSAtmosphereTheme;
if (!atmosphereTheme) {
  throw new Error('IWS atmosphere theme module failed to load.');
}
const locationControllerModule = window.IWSLocationController;
if (!locationControllerModule) {
  throw new Error('IWS location controller module failed to load.');
}
const interactionControllerModule = window.IWSInteractionController;
if (!interactionControllerModule) {
  throw new Error('IWS interaction controller module failed to load.');
}

const {
  ForecastNormalizationError,
  isPlainObject,
  isDaylightRow,
  tUtc,
  tMs,
  normalizeForecastWindow,
  normalizeTimelineRow,
  normalizeForecastPayload,
  bucketForecastRowsByDay,
} = forecastModel;
const {
  chartAxisKeyForRows: chartAxisKeyForRowsRenderer,
  renderChart: renderChartModule,
} = chartRenderer;
const {
  renderTimeline: renderTimelineModule,
  renderTimelineState: renderTimelineStateModule,
} = timelineRenderer;
const {
  computeAtmosphericTheme: computeAtmosphericThemeModule,
  applyAtmosphericTheme: applyAtmosphericThemeModule,
  resetAtmosphericTheme: resetAtmosphericThemeModule,
} = atmosphereTheme;

// Derived forecast selectors live in a dedicated file so rules stay decoupled from DOM rendering.
const forecastSelectors = window.IWSForecastSelectors?.createForecastSelectors?.({
  isDaylightRow,
  tUtc,
  tMs,
  localHourForDate,
  config: {
    DEFAULT_THRESHOLD,
    MEANINGFUL_WINDOW_MINUTES,
    SUN_BREAK_THRESHOLD,
    SUN_BREAK_MINIMUM_MINUTES,
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

// Day bucketing
function prepareDayBuckets(data) {
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

function computeAtmosphericTheme(row, twilightContext = null) {
  return computeAtmosphericThemeModule(row, twilightContext, { tUtc });
}

function applyAtmosphericTheme(row, twilightContext = null) {
  applyAtmosphericThemeModule(row, twilightContext, { tUtc });
}

function resetAtmosphericTheme() {
  resetAtmosphericThemeModule();
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

// ===== Cache =====
function cacheKey(lat, lon) {
  const rlat = Number(lat).toFixed(COORD_CACHE_KEY_DECIMALS);
  const rlon = Number(lon).toFixed(COORD_CACHE_KEY_DECIMALS);
  return `iwannasun_day_v2_${rlat}_${rlon}`;
}

function loadCached(lat, lon, maxAgeMs = 5 * 60 * 1000) {
  try {
    const key = cacheKey(lat, lon);
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

function clearCached(lat, lon) {
  try {
    sessionStorage.removeItem(cacheKey(lat, lon));
  } catch {
    // ignore privacy mode / quota behavior
  }
}

function saveCached(lat, lon, data) {
  try {
    const key = cacheKey(lat, lon);
    sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // ignore quota / privacy mode
  }
}

// ===== API =====
function buildDayUrl(lat, lon) {
  return `${API_BASE}/day?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
}

function applyForecastPayload(data, {
  usedModel = '',
  fallbackFromRay = null,
  fallbackReason = 'Using local geometry fallback (ray unavailable).',
} = {}) {
  state.data = data;
  state.tzName = data?.meta?.tz_name || null;
  state.geometryMode = String(data?.model || usedModel || '').toLowerCase() || null;
  const inferredFallback = (fallbackFromRay == null)
    ? (state.geometryMode === 'local')
    : Boolean(fallbackFromRay && state.geometryMode === 'local');
  state.rayFallbackActive = inferredFallback;
  state.rayFallbackReason = state.rayFallbackActive ? String(fallbackReason || '') : '';
  prepareDayBuckets(state.data);
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

  const url = buildDayUrl(lat, lon);

  if (!force) {
    const cached = loadCached(lat, lon, 5 * 60 * 1000);
    if (cached) {
      let normalizedCached = null;
      try {
        normalizedCached = normalizeForecastPayload(cached);
      } catch (e) {
        if (!(e instanceof ForecastNormalizationError)) throw e;
        clearCached(lat, lon);
        console.warn('IWS_MALFORMED_CACHED_FORECAST', e);
        normalizedCached = null;
      }

      if (normalizedCached) {
        if (!isCurrent()) return;
        applyForecastPayload(normalizedCached, {
          fallbackReason: 'Using local geometry fallback (ray unavailable on last successful fetch).',
        });
        render();
        if (isCurrent()) setBusy(false);
        return;
      }
    }
  }

  try {
    if (_dayAbort) _dayAbort.abort();
    _dayAbort = new AbortController();
    const { signal } = _dayAbort;

    const res = await fetch(url, { signal });
    if (!isCurrent()) return;

    if (!res.ok) {
      let msg = '';
      try {
        const errBody = await res.json();
        msg = (typeof errBody?.detail === 'string') ? errBody.detail : '';
      } catch {}
      const errCode = (res.headers?.get?.('X-IWS-Error-Code') || '').trim();

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

      let apiMsg = `API error ${res.status}`;
      if (msg) apiMsg = msg;
      if (isCurrent()) {
        if (!state.data) clearForecastUi();
        showError(apiMsg);
      }
      return;
    }

    const rawData = await res.json();
    if (!isCurrent()) return;
    const data = normalizeForecastPayload(rawData);
    applyForecastPayload(data, {
      fallbackReason: 'Using local geometry fallback (ray unavailable).',
    });
    if (state.rayFallbackActive) {
      console.info('IWS_MODEL_FALLBACK', {
        from: 'ray',
        to: 'local',
        source: 'backend_auto_day',
      });
    }

    saveCached(lat, lon, rawData);
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
  fillEl.style.background = color || PUBLIC_RUNTIME_COLORS.meterFillNeutral;
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
    setMeter(els.meterScore, 0, PUBLIC_RUNTIME_COLORS.meterFillEmpty);
    setMeter(els.meterConf, 0, PUBLIC_RUNTIME_COLORS.meterFillEmpty);
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
    setMeter(els.meterConf, 0, PUBLIC_RUNTIME_COLORS.meterFillEmpty);
  } else {
    const cp = Math.round(c * 100);
    if (els.confNow) {
      els.confNow.textContent = cp + '%';
      els.confNow.title = isAvg
        ? 'Confidence average across daylight hours (higher = more stable conditions).'
        : 'Confidence = how reliable the sun score estimate is (higher = more stable conditions).';
    }
    // Confidence uses a neutral ink color (not the sunny color) so it feels distinct
    setMeter(els.meterConf, cp, PUBLIC_RUNTIME_COLORS.meterFillStrong);
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
    els.decisionLead.innerHTML = isTomorrow
      ? '<span class="decisionContext decisionContextSubtle">Based on daylight sun score average.</span>'
      : '';
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
    renderTimelineModule({
    timelineEl: els.timeline,
    visibleRows,
    fmtTime,
    tUtc,
    isDaylightRow,
    mixSunColor,
    clamp,
  });
}

function renderChart(dayRows, win = null, rowsOverride = null) {
  const chartHover = interactionController?.getChartHover?.() || { active: false, idx: -1 };
  const result = renderChartModule({
    canvas: els.canvas,
    ctx,
    yAxisEl: els.yAxis,
    xAxisEl: els.xAxis,
    dayRows,
    win,
    rowsOverride,
    prevAxisKey: _chartAxisKey,
    hover: chartHover,
    tzName: state.tzName,
    daylightWindow,
    chartRowsForWindow,
    maxElevationFromRows,
    mixSunColor,
    clamp,
    fmtTime,
    tUtc,
  });
  if (!result) return;
  _chartAxisKey = result?.axisKey || '';
  if (interactionController) interactionController.setChartGeom(result?.geom || null);
}

function ensurePreparedDays() {
  const dayIndex = currentDayIndex();
  let dayRows = (state.days && state.days[dayIndex]) ? state.days[dayIndex] : null;
  if (!dayRows) {
    prepareDayBuckets(state.data);
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
    setTimePillValue(fmtTime(new Date()));
    els.timePill.title = `Local time (${state.tzName})`;
  } else {
    setTimePillValue('—');
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
  renderTimelineStateModule({
    timelineEl: els.timeline,
    timelineState,
    fmtTime,
    tUtc,
    isDaylightRow,
    mixSunColor,
    clamp,
  });
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
  return chartAxisKeyForRowsRenderer(rows, {
    tzName,
    maxElevOverride,
    maxElevationFromRows,
  });
}

// Snapshot + diffing stay in app.js so orchestration can decide which UI
// surfaces need updates without pushing cross-surface policy into render modules.
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
    if (interactionController) interactionController.reset();
  }

  function getSelectorTestInternals() {
    const chartHover = interactionController?.getChartHover?.() || { active: false, idx: -1 };
    const chartGeom = interactionController?.getChartGeom?.() || null;
    return {
      lastRenderSnapshot: _lastRenderSnapshot ? { ..._lastRenderSnapshot } : null,
      chartAxisKey: _chartAxisKey,
      chartHover: { active: chartHover.active, idx: chartHover.idx },
      chartGeom: chartGeom ? { ...chartGeom } : null,
    };
  }

  function setSelectorTestChartHover({
    active = false,
    idx = -1,
    geom = undefined,
  } = {}) {
    if (!interactionController) return;
    interactionController.setSelectorTestChartHover({ active, idx, geom });
  }

  // Keep the browser selector test surface stable even as app internals move
  // behind dedicated modules.
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

// Keep UI fresh (time pill + “now” marker)
let _lastUiMinute = null;

locationController = locationControllerModule.createLocationController({
  els,
  state,
  roundCoord,
  coordStateDecimals: COORD_STATE_DECIMALS,
  clearForecastUi,
  fetchDay,
  showError,
  setBusy,
  nextPaint,
  onLocationStateChange: syncShareableUrlState,
});
interactionController = interactionControllerModule.createInteractionController({
  els,
  state,
  testMode: IWS_SELECTOR_TEST_MODE,
  clamp,
  debounce,
  renderSoon,
  nextPaint,
  redrawChartOnly,
  fetchDay,
  refreshTimeSensitiveUi,
});

function setLocation(lat, lon, label = '') {
  if (!locationController) return;
  locationController.setLocation(lat, lon, label);
}

function useHere(opts = {}) {
  if (!locationController) return Promise.resolve();
  return locationController.useHere(opts);
}

locationController.attach();
interactionController.attach();
if (els.daySelect) {
  els.daySelect.addEventListener('change', () => {
    syncShareableUrlState();
  });
}
if (els.btnShare) {
  els.btnShare.addEventListener('click', () => {
    handleShareClick();
  });
}
updateClearLocationButton();

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

  const sharedView = readViewStateFromUrl();
  if (els.daySelect) {
    els.daySelect.value = String(sharedView.dayIndex);
  }

  if (sharedView.hasLocation) {
    setLocation(sharedView.lat, sharedView.lon, sharedView.label);
    fetchDay(false);
    return;
  }

  const preset = locationController ? locationController.getPresetLocation() : null;
  if (preset) {
    setLocation(preset.lat, preset.lon, preset.label);
    fetchDay(false);
    return;
  }

  useHere({ silent: false });
});
