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
const DAYS = 2;
const COORD_STATE_DECIMALS = 3;
const COORD_CACHE_KEY_DECIMALS = 3;
const COORD_UI_DECIMALS = 2;

// Timeline limits
const TIMELINE_MAX_ROWS = 84;

// Rate limiting
const RL_STORAGE_KEY = 'iwannasun_rate_limit_until';
const RL_PROVIDER_DEFAULT_COOLDOWN_S = 15; // Open-Meteo / forecast provider
const RL_USER_DEFAULT_COOLDOWN_S = 10;     // your API (slow down)

// ===== DOM =====
const $ = (id) => document.getElementById(id);

const els = {
  locPill: $('locPill'),
  timePill: $('timePill'),
  cityInput: $('cityInput'),
  cityResults: $('cityResults'),
  errBox: $('errBox'),
  loadingOverlay: $('loadingOverlay'),

  btnHere: $('btnHere'),
  btnRefresh: $('btnRefresh'),
  daySelect: $('daySelect'),

  decisionWrap: $('decisionWrap'),
  decisionText: $('decisionText'),
  decisionContext: $('decisionContext'),
  whyInline: $('whyInline'),

  labelScore: $('labelScore'),
  labelConf: $('labelConf'),

  scoreNow: $('scoreNow'),
  confNow: $('confNow'),

  meterScore: $('meterScore'),
  meterConf: $('meterConf'),

  nextWindow: $('nextWindow'),
  nextWindowSub: $('nextWindowSub'),
  sunriseTime: $('sunriseTime'),
  sunsetTime: $('sunsetTime'),

  timeline: $('timeline'),
  yAxis: $('yAxis'),
  xAxis: $('xAxis'),
  canvas: $('sunChart'),
};

const ctx = els.canvas ? els.canvas.getContext('2d') : null;

// ===== State =====
const state = {
  lat: null,
  lon: null,
  label: '',
  data: null,
  days: null,
  tzName: null,
  isBusy: false,
  rateLimitUntil: 0,
  rateLimitMsg: '',
};

// Theme accent anchors used by chart/timeline score coloring.
const themeAccents = {
  sky: { r: 0x9b, g: 0xbe, b: 0xd9 },
  sun: { r: 0xf4, g: 0xb8, b: 0x60 },
};
let _lastAtmosThemeKey = '';

// ===== Mood =====
function setMood(mood) {
  // Apply mood classes to <html> (root), not <body>
  const root = document.documentElement; // <html>
  if (!root) return;
  root.classList.remove('mood-sunny', 'mood-mixed', 'mood-blocked');
  if (mood) root.classList.add(`mood-${mood}`);
}


// ===== Request control =====
let _dayAbort = null;

// ===== Helpers =====
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function roundCoord(x, decimals = 3) {
  const p = Math.pow(10, decimals);
  return Math.round(Number(x) * p) / p;
}
const nextPaint = () => new Promise((r) => requestAnimationFrame(r));

function hslToRgb(h, s, l) {
  const hh = (((Number(h) % 360) + 360) % 360) / 360;
  const ss = clamp(Number(s) / 100, 0, 1);
  const ll = clamp(Number(l) / 100, 0, 1);
  if (ss === 0) {
    const g = Math.round(ll * 255);
    return { r: g, g, b: g };
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const hue2rgb = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(hh + 1 / 3) * 255),
    g: Math.round(hue2rgb(hh) * 255),
    b: Math.round(hue2rgb(hh - 1 / 3) * 255),
  };
}

function blendRgb(a, b, t) {
  const u = clamp(Number(t || 0), 0, 1);
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
  };
}

function setThemeAccents({ sky, sun }) {
  if (sky && Number.isFinite(sky.r) && Number.isFinite(sky.g) && Number.isFinite(sky.b)) {
    themeAccents.sky = {
      r: clamp(Math.round(sky.r), 0, 255),
      g: clamp(Math.round(sky.g), 0, 255),
      b: clamp(Math.round(sky.b), 0, 255),
    };
  }
  if (sun && Number.isFinite(sun.r) && Number.isFinite(sun.g) && Number.isFinite(sun.b)) {
    themeAccents.sun = {
      r: clamp(Math.round(sun.r), 0, 255),
      g: clamp(Math.round(sun.g), 0, 255),
      b: clamp(Math.round(sun.b), 0, 255),
    };
  }
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
  renderSoon();
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
  renderSoon();
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

function daylightWindow(dayRows, padMinutes = 30) {
  const rows = (dayRows || []);
  let first = null;
  let last = null;

  for (const r of rows) {
    if (isDaylightRow(r)) { first = tUtc(r); break; }
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isDaylightRow(rows[i])) { last = tUtc(rows[i]); break; }
  }
  if (!first || !last) return null;

  const start = new Date(first.getTime() - padMinutes * 60000);
  const end = new Date(last.getTime() + padMinutes * 60000);
  return { start, end };
}


// Day bucketing
function prepData(data) {
  if (!data?.timeline) return;
  const days = {};
  for (const r of data.timeline) {
    tUtc(r);
    const di = Number(r.day_index || 0);
    (days[di] ||= []).push(r);
  }
  // Ensure stable ordering (just in case)
  for (const k of Object.keys(days)) {
    days[k].sort((a, b) => tMs(a) - tMs(b));
  }
  state.days = days;
}

// ===== Metrics (Tomorrow averages) =====
function dayAverages(dayRows) {
  const rows = (dayRows || []).filter(r => isDaylightRow(r));
  if (!rows.length) return null;

  let sumScore = 0;
  let sumConf = 0;
  let nScore = 0;
  let nConf = 0;

  // Keep separate counters per field so missing values do not bias averages.
  let sumLow = 0, sumMid = 0, sumHigh = 0, sumPrecip = 0;
  let nLow = 0, nMid = 0, nHigh = 0, nPrecip = 0;

  for (const r of rows) {
    const s = Number(r.sun_score);
    if (Number.isFinite(s)) { sumScore += s; nScore++; }

    const c = Number(r.confidence);
    if (Number.isFinite(c)) { sumConf += c; nConf++; }

    const low = Number(r.cloud?.low);
    if (Number.isFinite(low)) { sumLow += low; nLow++; }

    const mid = Number(r.cloud?.mid);
    if (Number.isFinite(mid)) { sumMid += mid; nMid++; }

    const high = Number(r.cloud?.high);
    if (Number.isFinite(high)) { sumHigh += high; nHigh++; }

    const pr = Number(r.cloud?.precip_mm);
    if (Number.isFinite(pr)) { sumPrecip += pr; nPrecip++; }
  }

  const avgScore = nScore ? (sumScore / nScore) : 0;
  const avgConf = nConf ? (sumConf / nConf) : 0;

  const avgLow = nLow ? (sumLow / nLow) : 0;
  const avgMid = nMid ? (sumMid / nMid) : 0;
  const avgHigh = nHigh ? (sumHigh / nHigh) : 0;
  const avgPrecip = nPrecip ? (sumPrecip / nPrecip) : 0;

  const layers = [
    { name: 'low clouds', v: avgLow },
    { name: 'mid clouds', v: avgMid },
    { name: 'high clouds', v: avgHigh },
  ].sort((a, b) => b.v - a.v);

  return {
    avgScore,
    avgConf,
    clouds: { low: avgLow, mid: avgMid, high: avgHigh, precip_mm: avgPrecip },
    topLayer: layers[0],
  };
}

// Color mix: 0 = cloudy, 1 = sunny
function mixSunColor(t, alpha = 1) {
  t = clamp(Number(t || 0), 0, 1);

  // Piecewise palette tuned for readability and score semantics:
  // >90: strong golden amber, 70-90: warm amber, 50-70: pale amber, <50: muted amber-grey.
  // Kept slightly deeper than background glow so chart accents remain legible.
  const mutedLow = { r: 160, g: 162, b: 144 };
  const muted = { r: 186, g: 176, b: 136 };
  const pale = { r: 214, g: 190, b: 118 };
  const warm = { r: 236, g: 176, b: 74 };
  const gold = { r: 246, g: 186, b: 62 };

  let rgb = mutedLow;
  if (t >= 0.9) {
    rgb = blendRgb(warm, gold, (t - 0.9) / 0.1);
  } else if (t >= 0.7) {
    rgb = blendRgb(pale, warm, (t - 0.7) / 0.2);
  } else if (t >= 0.5) {
    rgb = blendRgb(muted, pale, (t - 0.5) / 0.2);
  } else {
    rgb = blendRgb(mutedLow, muted, t / 0.5);
  }

  // Keep palette gently aligned with atmospheric accents.
  if (t >= 0.6) {
    rgb = blendRgb(rgb, themeAccents.sun, 0.12 * clamp((t - 0.6) / 0.4, 0, 1));
  } else {
    rgb = blendRgb(rgb, themeAccents.sky, 0.08 * clamp((0.6 - t) / 0.6, 0, 1));
  }

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

function directionalGlowPreset(localHour, elevationDeg, isFallback) {
  if (isFallback || !Number.isFinite(elevationDeg) || elevationDeg <= 0.25) {
    return 'night';
  }
  const h = Number(localHour);
  if (!Number.isFinite(h)) return 'night';
  if (h < 7.5) return 'sunrise';
  if (h < 9.5) return 'morning';
  if (h < 11.5) return 'late_morning';
  if (h < 13.5) return 'noon';
  if (h < 15.5) return 'afternoon';
  if (h < 17.5) return 'late_afternoon';
  return 'sunset';
}

function computeAtmosphericTheme(row) {
  const now = new Date();
  const score = clamp(toNumberOrNaN(row?.sun_score) || 0, 0, 100);
  const sunT = score / 100;
  const elev = toNumberOrNaN(row?.elevation);

  const rowDate = row ? tUtc(row) : null;
  const refDate = (rowDate instanceof Date && !Number.isNaN(rowDate.getTime()))
    ? rowDate
    : now;
  const localHour = localHourForDate(refDate);
  const dayPhase = clamp((localHour - 6) / 12, 0, 1);
  const midday = Math.sin(dayPhase * Math.PI);
  const elevClamped = Number.isFinite(elev) ? clamp(elev, 0, 90) : (midday * 55);
  const elevT = clamp(elevClamped / 90, 0, 1);
  const fallbackMode = Boolean(row?._themeFallback);
  const preset = directionalGlowPreset(localHour, elevClamped, fallbackMode);

  const fragility = clamp(cloudFragilityFromRow(row), 0, 1);
  const saturation = clamp(24 + 54 * sunT - 10 * fragility, 18, 76);
  const hue = clamp(203 + (1 - sunT) * 7, 201, 214);

  // Three-layer light atmosphere: deeper top, sky-rich middle, bright horizon.
  const skyTop = `hsl(${hue} ${clamp(saturation * 0.78, 16, 60)}% ${clamp(69 + 11 * sunT + 5 * elevT - 5 * fragility, 60, 86)}%)`;
  const skyMid = `hsl(${hue} ${clamp(saturation, 18, 76)}% ${clamp(81 + 11 * sunT + 4 * elevT - 3 * fragility, 72, 95)}%)`;
  const skyBottom = `hsl(${clamp(hue - 2, 198, 216)} ${clamp(saturation * 0.86, 16, 66)}% ${clamp(93 + 5 * sunT + 2 * (1 - elevT), 88, 99)}%)`;

  const presetWarm = ({
    sunrise: 1.0,
    morning: 0.62,
    late_morning: 0.34,
    noon: 0.18,
    afternoon: 0.34,
    late_afternoon: 0.62,
    sunset: 1.0,
    night: 0.42,
  })[preset] ?? 0.5;
  const sunWarm = clamp(0.55 * presetWarm + 0.35 * (1 - elevT) + 0.10 * (1 - midday), 0, 1);
  const glowHue = clamp(Math.round(52 - 29 * sunWarm), 20, 52);
  const glowSat = clamp(Math.round(72 + 18 * sunT - 4 * fragility), 62, 94);
  const glowLight = clamp(Math.round(71 + 8 * sunT + 4 * midday), 65, 89);
  const glowCoreAlpha = clamp(0.20 + 0.22 * sunT * (0.45 + 0.55 * elevT), 0.16, 0.46);
  const glowStrongAlpha = clamp(0.16 + 0.20 * sunT * (0.50 + 0.50 * elevT), 0.13, 0.38);
  const glowSoftAlpha = clamp(0.09 + 0.11 * sunT * (0.55 + 0.45 * elevT), 0.08, 0.24);

  // Intentionally discrete directional communication for user-facing sky feel.
  const glowPos = ({
    sunrise: { x: 16, y: 84 },
    morning: { x: 46, y: 82 },
    late_morning: { x: 28, y: 24 },
    noon: { x: 50, y: 14 },
    afternoon: { x: 74, y: 24 },
    late_afternoon: { x: 84, y: 50 },
    sunset: { x: 82, y: 84 },
    night: { x: 50, y: 86 },
  })[preset] || { x: 50, y: 86 };
  const glowX = clamp(glowPos.x, 6, 94);
  const glowY = clamp(glowPos.y, 8, 94);

  const overlayAlpha = clamp(0.03 + 0.08 * (1 - sunT) + 0.05 * fragility, 0.02, 0.14);
  const cardAlpha = clamp(0.68 + 0.06 * fragility - 0.04 * sunT, 0.60, 0.80);
  const cardAlpha2 = clamp(cardAlpha - 0.10, 0.48, 0.70);

  const skyAccent = hslToRgb(hue + 1, clamp(30 + sunT * 26, 24, 64), clamp(64 + sunT * 9, 60, 80));
  const sunAccent = hslToRgb(glowHue, clamp(76 + 14 * sunT, 72, 95), clamp(64 + 8 * sunT, 60, 84));

  return {
    skyTop,
    skyMid,
    skyBottom,
    glowCore: `hsl(${glowHue} ${Math.min(95, glowSat + 3)}% ${Math.min(92, glowLight + 8)}% / ${glowCoreAlpha.toFixed(3)})`,
    glowHalo: `hsl(${glowHue} ${Math.max(56, glowSat - 6)}% ${Math.max(58, glowLight - 1)}% / ${glowStrongAlpha.toFixed(3)})`,
    glowStrong: `hsl(${glowHue} ${glowSat}% ${glowLight}% / ${glowStrongAlpha.toFixed(3)})`,
    glowSoft: `hsl(${glowHue} ${Math.max(48, glowSat - 16)}% ${Math.max(38, glowLight - 6)}% / ${glowSoftAlpha.toFixed(3)})`,
    glowX: `${glowX.toFixed(1)}%`,
    glowY: `${glowY.toFixed(1)}%`,
    overlay: `rgba(255, 255, 255, ${overlayAlpha.toFixed(3)})`,
    card: `rgba(255, 255, 255, ${cardAlpha.toFixed(3)})`,
    card2: `rgba(255, 255, 255, ${cardAlpha2.toFixed(3)})`,
    accents: { sky: skyAccent, sun: sunAccent },
  };
}

function applyAtmosphericTheme(row) {
  if (!document.body || document.body.classList.contains('solarApiPage')) return;
  const root = document.documentElement;
  if (!root) return;
  const theme = computeAtmosphericTheme(row || null);
  const themeKey = [
    theme.skyTop,
    theme.skyMid,
    theme.skyBottom,
    theme.glowCore,
    theme.glowHalo,
    theme.glowStrong,
    theme.glowSoft,
    theme.glowX,
    theme.glowY,
    theme.overlay,
    theme.card,
    theme.card2,
    theme.accents?.sky?.r, theme.accents?.sky?.g, theme.accents?.sky?.b,
    theme.accents?.sun?.r, theme.accents?.sun?.g, theme.accents?.sun?.b,
  ].join('|');
  if (themeKey === _lastAtmosThemeKey) return;
  _lastAtmosThemeKey = themeKey;
  root.style.setProperty('--atm-sky-top', theme.skyTop);
  root.style.setProperty('--atm-sky-mid', theme.skyMid);
  root.style.setProperty('--atm-sky-bottom', theme.skyBottom);
  root.style.setProperty('--atm-glow-core', theme.glowCore);
  root.style.setProperty('--atm-glow-halo', theme.glowHalo);
  root.style.setProperty('--atm-glow-strong', theme.glowStrong);
  root.style.setProperty('--atm-glow-soft', theme.glowSoft);
  root.style.setProperty('--atm-glow-x', theme.glowX);
  root.style.setProperty('--atm-glow-y', theme.glowY);
  root.style.setProperty('--atm-overlay', theme.overlay);
  root.style.setProperty('--atm-card', theme.card);
  root.style.setProperty('--atm-card-2', theme.card2);
  setThemeAccents(theme.accents);
}

// ===== Rate limit cooldown =====
let _rlTimer = null;
function loadRateLimitUntil() {
  try {
    const raw = sessionStorage.getItem(RL_STORAGE_KEY);
    const v = Number(raw || 0);
    if (Number.isFinite(v) && v > 0) state.rateLimitUntil = v;
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

  if (_rlTimer) clearInterval(_rlTimer);
  _rlTimer = setInterval(() => {
    if (Date.now() >= state.rateLimitUntil) {
      clearRateLimit();
      clearError();
    } else {
      applyRateLimitUi();
    }
  }, 500);

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
  state.lat = roundCoord(lat, COORD_STATE_DECIMALS);
  state.lon = roundCoord(lon, COORD_STATE_DECIMALS);
  state.label = (label || '').trim();

  state.data = null;
  state.days = null;
  state.tzName = null;

  if (els.locPill) {
    els.locPill.textContent = state.label ? state.label : `${state.lat.toFixed(COORD_UI_DECIMALS)}, ${state.lon.toFixed(COORD_UI_DECIMALS)}`;
  }
  if (els.timePill) {
    els.timePill.textContent = '—';
    els.timePill.title = '';
  }
  // For the input: if label is "My location", keep it empty (so it doesn't look like a locked value)
  if (els.cityInput) {
    els.cityInput.value = (state.label && state.label !== 'My location') ? state.label : '';
  }
}

// ===== City search (Open-Meteo geocoding) =====
let _cityTimer = null;
let _lastCityQuery = '';
let _lastCityResults = [];
let _cityActiveIndex = -1;

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
  const query = (q || '').trim();
  if (query.length < 2) return hideCityResults();
  if (query === _lastCityQuery) return;
  _lastCityQuery = query;

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('geocoding failed');
    const data = await res.json();
    _lastCityResults = data?.results || [];
    _cityActiveIndex = -1;
    renderCityResults(_lastCityResults);
  } catch {
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

async function fetchDay(force = false) {
  // Respect cooldown (even if user spams Refresh)
  // IMPORTANT: if we return early, make sure we aren't leaving the UI in a busy state.
  if (rateLimitRemainingMs() > 0) {
    applyRateLimitUi();
    setBusy(false);
    return;
  }

  setBusy(true);
  await nextPaint();
  clearError();

  const lat = state.lat;
  const lon = state.lon;
  if (lat == null || lon == null) {
    showError('No location set');
    setBusy(false);
    return;
  }

  const threshold = DEFAULT_THRESHOLD;
  const wantedMode = 'full';

  const { urlRay, urlLocal } = buildDayUrls(lat, lon, threshold, DAYS, wantedMode);

  if (!force) {
    let cached = loadCached(lat, lon, threshold, 5 * 60 * 1000, { days: DAYS, model: 'ray', mode: wantedMode });
    if (!cached) cached = loadCached(lat, lon, threshold, 5 * 60 * 1000, { days: DAYS, model: 'local', mode: wantedMode });
    if (cached) {
      state.data = cached;
      state.tzName = cached?.meta?.tz_name || null;
      prepData(state.data);
      render();
      setBusy(false);
      return;
    }
  }

  try {
    if (_dayAbort) _dayAbort.abort();
    _dayAbort = new AbortController();
    const { signal } = _dayAbort;

    let usedModel = 'ray';
    let res = await fetch(urlRay, { signal });

    if (!res.ok) {
      let msg = '';
      try {
        const errBody = await res.json();
        msg = (typeof errBody?.detail === 'string') ? errBody.detail : '';
      } catch {}
      const errCode = (res.headers?.get?.('X-IWS-Error-Code') || '').trim();

      // Provider rate limit (Open-Meteo). Backend returns 503 and should include Retry-After.
      if (res.status === 503 && (errCode === 'UPSTREAM_RATE_LIMIT' || msg.toLowerCase().includes('rate limit'))) {
        handleCooldownResponse(res, RL_PROVIDER_DEFAULT_COOLDOWN_S, 15 * 60, 'Rate limited by forecast provider. Please wait.');
        return;
      }

      // Your API limiter (user spamming). Backend returns 429 and should include Retry-After.
      if (res.status === 429) {
        handleCooldownResponse(res, RL_USER_DEFAULT_COOLDOWN_S, 60, 'Slow down, too many requests to our service.');
        return;
      }

      // Otherwise: fall back to local model if ray failed for non-rate-limit reasons.
      usedModel = 'local';
      res = await fetch(urlLocal, { signal });
    }

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const j = await res.json();
        if (typeof j?.detail === 'string') msg = j.detail;
      } catch {}
      showError(msg);
      return;
    }

    const data = await res.json();
    state.data = data;
    state.tzName = data?.meta?.tz_name || null;
    prepData(state.data);

    saveCached(lat, lon, threshold, data, { days: DAYS, model: usedModel, mode: wantedMode });
    render();
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 20)) return;
    showError('Network error (could not reach API).');
    console.error(e);
  } finally {
    setBusy(false);
  }
}

// ===== Rendering =====
function setMeter(fillEl, pct, color) {
  if (!fillEl) return;
  const p = clamp(Number(pct || 0), 0, 100);
  fillEl.style.width = `${p}%`;
  fillEl.style.background = color || 'rgba(51,51,51,0.22)';
}

function renderDecision(focusRow, context = { label: 'now' }) {
  if (!focusRow) {
    if (els.decisionText) els.decisionText.textContent = '—';
    if (els.scoreNow) els.scoreNow.textContent = '—';
    if (els.confNow) els.confNow.textContent = '—';
    if (els.decisionContext) els.decisionContext.textContent = '';
    if (els.whyInline) els.whyInline.textContent = '';
    setMeter(els.meterScore, 0, 'rgba(51,51,51,0.10)');
    setMeter(els.meterConf, 0, 'rgba(51,51,51,0.10)');
    setMood(null);
    return;
  }

  const label = String(context?.label || '');
  const isNow = label === 'now';
  const isAvg = label.toLowerCase().includes('average');

  if (els.decisionContext) els.decisionContext.textContent = isNow ? '' : `Based on ${label}`;
  if (els.labelScore) els.labelScore.textContent = isNow ? 'Sun score now' : (isAvg ? 'Sun score (avg)' : 'Sun score');
  // Confidence label text adjusts depending on context (now vs average)
  if (els.labelConf) els.labelConf.firstChild && (els.labelConf.firstChild.textContent = isNow ? 'Confidence now ' : (isAvg ? 'Confidence (avg) ' : 'Confidence '));

  const s = Number(focusRow.sun_score || 0);
  const c = Number(focusRow.confidence || 0);

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

  // Decision text (same thresholds / behavior)
  const decision = (s >= DEFAULT_THRESHOLD) ? 'Sunny' : (s >= DEFAULT_THRESHOLD - 15 ? 'Mixed' : 'Blocked');
  if (els.decisionText) els.decisionText.textContent = decision;
  if (els.decisionWrap) {
    els.decisionWrap.className = 'big';
    els.decisionWrap.style.color = sunColor;
  }

  // Set wellness mood class on <html> root
  if (decision === 'Sunny') setMood('sunny');
  else if (decision === 'Mixed') setMood('mixed');
  else setMood('blocked');

  // WHY (short, decision-oriented)
  if (els.whyInline) {
    if (Number(focusRow.elevation || 0) <= 0) {
      els.whyInline.textContent = 'Sun below the horizon.';
    } else {
      const low = focusRow.cloud?.low ?? null;
      const mid = focusRow.cloud?.mid ?? null;
      const high = focusRow.cloud?.high ?? null;
      const precip = focusRow.cloud?.precip_mm ?? 0;

      const parts = [];
      if (precip && precip > 0.2) parts.push('rain');

      const layers = [
        { name: 'low clouds', v: low },
        { name: 'mid clouds', v: mid },
        { name: 'high clouds', v: high },
      ].filter(x => typeof x.v === 'number');

      if (layers.length) {
        layers.sort((a, b) => b.v - a.v);
        if (layers[0].v >= 20) parts.push(`${layers[0].name} (${Math.round(layers[0].v)}%)`);
      }

      if (!parts.length) {
        els.whyInline.textContent = isAvg
          ? 'Mostly clear overall (daylight average).'
          : 'Clear sky and sun above the horizon.';
      } else {
        const prefix = isAvg
          ? ((s >= DEFAULT_THRESHOLD) ? 'Overall clear despite ' : 'Overall mostly blocked by ')
          : ((s >= DEFAULT_THRESHOLD) ? 'Clear despite ' : 'Mostly blocked by ');
        els.whyInline.textContent = prefix + parts.join(' + ') + '.';
      }
    }
  }
}

function renderNextWindow(win, label = null) {
  if (!els.nextWindow || !els.nextWindowSub) return;

  if (!win) {
    els.nextWindow.textContent = 'No sunny window';
    els.nextWindow.className = 'big bad';
    els.nextWindowSub.textContent = 'Try again later.';
    return;
  }

  const a = fmtTime(win.start);
  const b = fmtTime(win.end);
  els.nextWindow.textContent = `${a} – ${b}`;
  els.nextWindow.className = 'big good';

  if (label) {
    els.nextWindowSub.textContent = label;
    return;
  }

  const mins = (win.minutes != null)
    ? win.minutes
    : Math.max(0, Math.round((new Date(win.end) - new Date(win.start)) / 60000));
  els.nextWindowSub.textContent = `${mins} minutes above threshold`;
}

function renderTimeline(dayRows, dayIndex = 0, win = null) {
  if (!els.timeline) return;

  const nowMs = Date.now();
  win = win || daylightWindow(dayRows, 30);
  const endMsToday = win ? win.end.getTime() : Infinity;

  const parts = [];
  parts.push(
    '<div class="trow trowHead muted small">'
      + '<div>Time</div><div title="Confidence">Conf.</div><div>Sun score</div></div>'
  );

  let shown = 0;
  for (const r of (dayRows || [])) {
    const dt = tUtc(r);
    const inWin = win ? (dt >= win.start && dt <= win.end) : isDaylightRow(r);
    if (!inWin) continue;

    const ms = tMs(r);
    if (Number(dayIndex) === 0 && ms < nowMs) continue;
    if (Number(dayIndex) === 0 && ms > endMsToday) continue;
    if (shown >= TIMELINE_MAX_ROWS) break;

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

    shown += 1;
  }

  els.timeline.innerHTML = parts.join('');
}

function renderChart(dayRows, win = null) {
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
    if (els.yAxis) els.yAxis.innerHTML = '';
    if (els.xAxis) els.xAxis.innerHTML = '';
    return;
  }

  win = win || daylightWindow(dayRows, 30);
  if (!win) {
    _chartGeom = null;
    if (els.yAxis) els.yAxis.innerHTML = '';
    if (els.xAxis) els.xAxis.innerHTML = '';
    return;
  }

  let startIdx = 0;
  let endIdx = dayRows.length - 1;

  for (let i = 0; i < dayRows.length; i++) {
    if (tUtc(dayRows[i]) >= win.start) { startIdx = Math.max(0, i); break; }
  }
  for (let i = dayRows.length - 1; i >= 0; i--) {
    if (tUtc(dayRows[i]) <= win.end) { endIdx = Math.min(dayRows.length - 1, i); break; }
  }

  const rows = dayRows.slice(startIdx, endIdx + 1);

  const elevs = rows.map(r => Math.max(0, Number(r.elevation || 0)));
  const maxElevRaw = Math.max(...elevs, 1);
  const maxElev = Math.max(10, Math.ceil(maxElevRaw / 10) * 10);

  if (els.yAxis) {
    const ticks = [];
    for (let d = maxElev; d >= 0; d -= 10) ticks.push(d);
    els.yAxis.innerHTML = ticks.map(d => `<div>${d}°</div>`).join('');
  }

  if (els.xAxis) {
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

function nearestNowRow(dayRows) {
  const nowMs = Date.now();
  let best = null;
  let bestDt = Infinity;
  for (const r of (dayRows || [])) {
    const dt = Math.abs(tMs(r) - nowMs);
    if (dt < bestDt) { bestDt = dt; best = r; }
  }
  return best;
}

function nearestRowToLocalHour(dayRows, hour = 12) {
  const rows = (dayRows || []);
  if (!rows.length) return null;

  // Use the first row's UTC timestamp and then format/display with tz.
  // The selection is "closest to local hour" visually; this is only for a stable default row.
  const base = tUtc(rows[0]);
  const target = new Date(base);
  target.setHours(hour, 0, 0, 0);

  let best = rows[0];
  let bestDt = Infinity;
  for (const r of rows) {
    const t = tUtc(r);
    const dt = Math.abs(t - target);
    if (dt < bestDt) { bestDt = dt; best = r; }
  }
  return best;
}

function render() {
  if (!state.data) return;

  // Local time pill
  if (els.timePill) {
    if (state.tzName) {
      els.timePill.textContent = fmtTime(new Date());
      els.timePill.title = `Local time (${state.tzName})`;
    } else {
      els.timePill.textContent = '—';
      els.timePill.title = '';
    }
  }

  const dayIndex = Number(els.daySelect?.value || 0);

  let dayRows = (state.days && state.days[dayIndex]) ? state.days[dayIndex] : null;
  if (!dayRows) {
    prepData(state.data);
    dayRows = (state.days && state.days[dayIndex]) ? state.days[dayIndex] : [];
  }

  // ------------------------------
  // Tomorrow view uses daylight average instead of single-hour snapshot
  // ------------------------------
  let themeRow = null;
  if (dayIndex === 0) {
    const focusRow = nearestNowRow(dayRows);
    themeRow = focusRow || nearestRowToLocalHour(dayRows, 12);
    renderDecision(focusRow, { label: 'now' });
  } else {
    const avg = dayAverages(dayRows);

    if (!avg) {
      // No daylight tomorrow
      const fallback = nearestRowToLocalHour(dayRows, 12);
      if (fallback) fallback._themeFallback = true;
      themeRow = fallback;
      renderDecision(fallback, { label: 'tomorrow (no daylight)' });
    } else {
      const anchor = nearestRowToLocalHour(dayRows, 12);
      // Synthetic row for decision UI
      const synthetic = {
        sun_score: avg.avgScore,
        confidence: avg.avgConf,
        elevation: Number(anchor?.elevation || 1),
        azimuth: Number(anchor?.azimuth || 180),
        is_daylight: true,
        time_utc: anchor?.time_utc || null,
        time_local: anchor?.time_local || null,
        _themeFallback: true,
        cloud: avg.clouds,
      };
      themeRow = synthetic;
      renderDecision(synthetic, { label: 'tomorrow (daylight average)' });
    }
  }

  applyAtmosphericTheme(themeRow);

  // Next window
  let win = state.data.next_sunny_window_by_day
    ? (state.data.next_sunny_window_by_day[String(dayIndex)] || null)
    : (state.data.next_sunny_window || null);

  if (dayIndex === 0 && !win && state.data.next_sunny_window_by_day) {
    const w1 = state.data.next_sunny_window_by_day['1'] || null;
    if (w1) {
      renderNextWindow(w1, 'Tomorrow');
    } else {
      renderNextWindow(null);
    }
  } else {
    renderNextWindow(win);
  }

  // Sunrise/sunset (derived from daylight range like before)
  const dayWin = daylightWindow(dayRows, 0);
  if (els.sunriseTime && els.sunsetTime) {
    if (!dayWin) {
      els.sunriseTime.textContent = '—';
      els.sunsetTime.textContent = '—';
      els.sunriseTime.title = 'No sunrise (sun stays below horizon)';
      els.sunsetTime.title = 'No sunset (sun stays below horizon)';
    } else {
      els.sunriseTime.textContent = fmtTime(dayWin.start);
      els.sunsetTime.textContent = fmtTime(dayWin.end);
      els.sunriseTime.title = fmtDateTime(dayWin.start);
      els.sunsetTime.title = fmtDateTime(dayWin.end);
    }
  }

  const dayWin30 = daylightWindow(dayRows, 30);
  renderChart(dayRows, dayWin30);

  // Hide timeline if no daylight ahead for selected day
  const nowMs = Date.now();
  const hasDaylightAhead = (dayIndex === 0)
    ? (dayRows || []).some(r => isDaylightRow(r) && tMs(r) >= nowMs)
    : (dayRows || []).some(r => isDaylightRow(r));

  if (!hasDaylightAhead) {
    if (els.timeline) { els.timeline.style.display = 'none'; els.timeline.innerHTML = ''; }
  } else {
    if (els.timeline) els.timeline.style.display = 'block';
    renderTimeline(dayRows, dayIndex, dayWin30);
  }

  // Keep refresh disabled if rate-limited
  applyRateLimitUi();
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
            // Only update label; keep the same lat/lon and don't clear state.data
            state.label = String(city).trim();
            if (els.locPill) els.locPill.textContent = state.label;
            if (els.cityInput) els.cityInput.value = state.label;
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

  const hideIndicator = () => {
    indicator.classList.remove('active', 'armed', 'loading');
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
    hideIndicator();
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!isPulling || activeTouchId == null) return;
    const t = findTouchById(e.touches, activeTouchId);
    if (!t) return;

    const pull = clamp(t.clientY - startY, 0, MAX_PULL_PX);
    if (pull <= 0) {
      hideIndicator();
      return;
    }

    if (e.cancelable) e.preventDefault();
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
      hideIndicator();
      return;
    }

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

initMobilePullToRefresh();

// Keep UI fresh (time pill + “now” marker)
let _uiTick = null;
let _lastUiMinute = null;

function uiRefresh() {
  if (!state.data || state.isBusy) return;
  const m = Math.floor(Date.now() / 60000);
  if (_lastUiMinute === m) return;
  _lastUiMinute = m;
  render();
}

function startUiTick() {
  if (_uiTick) return;
  uiRefresh();
  _uiTick = setInterval(uiRefresh, 15 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) uiRefresh(); });
  window.addEventListener('focus', uiRefresh);
}

startUiTick();

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
  applyAtmosphericTheme(null);
  loadRateLimitUntil();
  applyRateLimitUi();

  state.lat = null;
  state.lon = null;
  state.data = null;

  if (els.locPill) els.locPill.textContent = 'Choose a location';
  if (els.timePill) { els.timePill.textContent = '—'; els.timePill.title = ''; }

  const preset = getPresetLocation();
  if (preset) {
    setLocation(preset.lat, preset.lon, preset.label);
    fetchDay(false);
    return;
  }

  useHere({ silent: false });
});
