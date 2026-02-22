'use strict';

/**
 * Frontend only improvements:
 * - clearer separation of Sun Score vs Confidence (small meters)
 * - better mobile behavior
 * - keep backend assumptions exactly the same
 *
 * Key fixes in this revision:
 * - Parse timeline timestamps using time_utc (authoritative) to avoid viewer-timezone bugs.
 * - Add 503 rate-limit cooldown (respects Retry-After when present) and block repeated refresh spam.
 * - Persist cooldown across reloads (sessionStorage).
 */

// CONFIG
const API_BASE = 'https://iwannasun.onrender.com';
const DEFAULT_THRESHOLD = 70;
const DAYS = 2;

// Timeline limits (less clutter, faster)
const TIMELINE_MAX_ROWS = 84;

// Rate-limit handling
const RL_STORAGE_KEY = 'iwannasun_rate_limit_until';
const RL_DEFAULT_COOLDOWN_S = 10;

// DOM
const $ = (id) => document.getElementById(id);

const els = {
  locPill: $('locPill'),
  timePill: $('timePill'),
  cityInput: $('cityInput'),
  cityResults: $('cityResults'),
  errBox: $('errBox'),
  loadingOverlay: $('loadingOverlay'),

  btnHere: $('btnHere'),
  btnDemo: $('btnDemo'),
  btnRefresh: $('btnRefresh'),
  daySelect: $('daySelect'),

  decisionWrap: $('decisionWrap'),
  decisionText: $('decisionText'),
  decisionContext: $('decisionContext'),
  whyInline: $('whyInline'),

  labelScore: $('labelScore'),
  labelConf: $('labelConf'),
  labelSun60: $('labelSun60'),
  labelSun120: $('labelSun120'),
  boxSun60: $('boxSun60'),
  boxSun120: $('boxSun120'),

  scoreNow: $('scoreNow'),
  confNow: $('confNow'),
  sun60: $('sun60'),
  sun120: $('sun120'),

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

// App state
const state = {
  lat: null,
  lon: null,
  label: '',
  data: null,
  days: null,
  tzName: null,
  isBusy: false,
  rateLimitUntil: 0,
};

// --- Mood (wellness tone shift)
function setMood(mood) {
  const b = document.body;
  if (!b) return;
  b.classList.remove('mood-sunny', 'mood-mixed', 'mood-blocked');
  if (mood) b.classList.add(`mood-${mood}`);
}


// Abort in-flight /day requests
let _dayAbort = null;

// --- small helpers
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const nextPaint = () => new Promise((r) => requestAnimationFrame(r));

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

  const disable = [els.btnHere, els.btnDemo, els.btnRefresh, els.daySelect, els.cityInput].filter(Boolean);
  for (const el of disable) el.disabled = !!isBusy;

  // rate-limit cooldown can also disable refresh (even when not busy)
  applyRateLimitUi();

  const fade = [els.btnHere, els.btnDemo, els.btnRefresh].filter(Boolean);
  for (const el of fade) el.style.opacity = isBusy ? '0.65' : '1';
}

// Prevent HTML injection
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Format times in the location timezone (not the viewer's)
const _fmtCache = new Map();
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

// Determine daylight
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

// Build day buckets
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

// Color mix: 0 -> cloudy blue, 1 -> sunny warm
function mixSunColor(t, alpha = 1) {
  t = clamp(Number(t || 0), 0, 1);
  const a = { r: 0x9b, g: 0xbe, b: 0xd9 };
  const b = { r: 0xf4, g: 0xb8, b: 0x60 };
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  const aa = clamp(alpha, 0, 1);
  return `rgba(${r}, ${g}, ${bl}, ${aa})`;
}

// --- Rate-limit cooldown
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
  saveRateLimitUntil(0);
  if (_rlTimer) { clearInterval(_rlTimer); _rlTimer = null; }
  applyRateLimitUi();
}
function startRateLimitCooldown(seconds, detailMsg = '') {
  const s = clamp(Number(seconds || 0), 5, 15 * 60);
  state.rateLimitUntil = Date.now() + s * 1000;
  saveRateLimitUntil(state.rateLimitUntil);

  if (_rlTimer) clearInterval(_rlTimer);
  _rlTimer = setInterval(() => {
    if (Date.now() >= state.rateLimitUntil) {
      clearRateLimit();
      clearError();
    } else {
      applyRateLimitUi(detailMsg);
    }
  }, 500);

  applyRateLimitUi(detailMsg);
}
function rateLimitRemainingMs() {
  return Math.max(0, state.rateLimitUntil - Date.now());
}
function applyRateLimitUi(detailMsg = '') {
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
    const suffix = detailMsg ? ` ${detailMsg}` : '';
    showError(`Rate limited by the API. Please wait ${secs}s and try again.${suffix}`);
  }
}

// --- Location
function setLocation(lat, lon, label = '') {
  state.lat = Number(lat);
  state.lon = Number(lon);
  state.label = (label || '').trim();

  state.data = null;
  state.days = null;
  state.tzName = null;

  if (els.locPill) {
    els.locPill.textContent = state.label ? state.label : `${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`;
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

// --- City search (Open-Meteo geocoding)
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
  els.cityResults.addEventListener('mousedown', (e) => {
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

// --- Cache
function cacheKey(lat, lon, threshold, { days = 2, model = 'ray' } = {}) {
  const rlat = Number(lat).toFixed(4);
  const rlon = Number(lon).toFixed(4);
  const thr = Number(threshold);
  return `iwannasun_day_${rlat}_${rlon}_${thr}_d${days}_m${model}`;
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

// --- API
async function fetchDay(force = false) {
  // Respect cooldown (even if user spams Refresh)
  if (rateLimitRemainingMs() > 0) {
    applyRateLimitUi();
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

  const base = `${API_BASE}/day?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
    + `&threshold=${encodeURIComponent(threshold)}&days=${DAYS}&mode=${encodeURIComponent(wantedMode)}`;

  const urlRay = base + `&model=ray`;
  const urlLocal = base + `&model=local`;

  if (!force) {
    let cached = loadCached(lat, lon, threshold, 5 * 60 * 1000, { days: DAYS, model: 'ray' });
    if (!cached) cached = loadCached(lat, lon, threshold, 5 * 60 * 1000, { days: DAYS, model: 'local' });
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
      try { msg = (await res.json())?.detail || ''; } catch {}

      if (res.status === 503 && msg.toLowerCase().includes('rate limited')) {
        // Try to honor Retry-After if available
        const ra = res.headers?.get?.('Retry-After');
        let cooldown = RL_DEFAULT_COOLDOWN_S;
        if (ra && /^\d+$/.test(ra)) cooldown = clamp(Number(ra), 5, 15 * 60);
        startRateLimitCooldown(cooldown, msg ? `(${msg})` : '');
        return;
      }

      usedModel = 'local';
      res = await fetch(urlLocal, { signal });
    }

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const j = await res.json();
        if (j?.detail) msg = String(j.detail);
      } catch {}
      showError(msg);
      return;
    }

    const data = await res.json();
    state.data = data;
    state.tzName = data?.meta?.tz_name || null;
    prepData(state.data);

    saveCached(lat, lon, threshold, data, { days: DAYS, model: usedModel });
    render();
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 20)) return;
    showError('Network error (could not reach API).');
    console.error(e);
  } finally {
    setBusy(false);
  }
}

// --- Rendering
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

  const isNow = context?.label === 'now';
  if (els.decisionContext) els.decisionContext.textContent = isNow ? '' : `Based on ${context.label}`;
  if (els.labelScore) els.labelScore.textContent = isNow ? 'Sun score now' : 'Sun score';
  // Keep “ⓘ” behavior, but we also added title in HTML
  if (els.labelConf) els.labelConf.firstChild && (els.labelConf.firstChild.textContent = isNow ? 'Confidence now ' : 'Confidence ');

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
      els.confNow.title = 'Confidence = how reliable the sun score estimate is (higher = more stable conditions).';
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

  // Set wellness mood class on body
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
        els.whyInline.textContent = 'Clear sky and sun above the horizon.';
      } else {
        const prefix = (s >= DEFAULT_THRESHOLD) ? 'Clear despite ' : 'Mostly blocked by ';
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

function renderChart(dayRows, dayIndex = 0, win = null) {
  if (!els.canvas || !ctx) return;

  const cssW = els.canvas.clientWidth || 900;
  const cssH = els.canvas.clientHeight || 220;
  const dpr = window.devicePixelRatio || 1;
  els.canvas.width = Math.round(cssW * dpr);
  els.canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = cssW;
  const h = cssH;

  ctx.clearRect(0, 0, w, h);

  if (!dayRows || !dayRows.length) {
    if (els.yAxis) els.yAxis.innerHTML = '';
    if (els.xAxis) els.xAxis.innerHTML = '';
    return;
  }

  win = win || daylightWindow(dayRows, 30);
  if (!win) {
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
      tt.setMinutes(0, 0, 0);
      labels.push(fmtTime(tt));
    }
    els.xAxis.innerHTML = labels.map(t => `<div>${t}</div>`).join('');
  }

  const padX = 14;
  const padTop = 14;
  const padBottom = 18;

  const yOf = (e) => {
    const usableH = h - padTop - padBottom;
    const yy = (h - padBottom) - (e / maxElev) * usableH;
    return clamp(yy, padTop, h - padBottom);
  };
  const xOf = (i) => rows.length === 1 ? w / 2 : padX + (i / (rows.length - 1)) * (w - 2 * padX);

  // grid lines
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
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

  // soft fill based on average score
  const avgScore = pts.reduce((acc, p) => acc + p.s, 0) / Math.max(1, pts.length);
  const tAvg = clamp(avgScore / 100, 0, 1);
  const fillAlpha = 0.04 + 0.14 * tAvg;

  const fillGrad = ctx.createLinearGradient(0, padTop, 0, h);
  fillGrad.addColorStop(0, mixSunColor(tAvg, fillAlpha));
  fillGrad.addColorStop(1, mixSunColor(tAvg, 0));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, h - padBottom);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.lineTo(pts[pts.length - 1].x, h - padBottom);
  ctx.closePath();
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // base line
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
    else ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.26)';
  ctx.stroke();

  // score intensity strokes
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.e <= 0 || b.e <= 0) continue;

    const t = clamp(((a.s + b.s) / 2) / 100, 0, 1);
    const elev = (a.e + b.e) / 2;
    const alpha = 0.05 + 0.95 * t;

    const thinNearHorizon = 0.55 + 0.45 * clamp(elev / 6, 0, 1);
    const lw = (1.0 + 9.0 * (t ** 0.9)) * thinNearHorizon;
    const glowFade = clamp(elev / 8, 0, 1);

    ctx.save();
    ctx.globalAlpha = alpha * 0.25 * glowFade;
    ctx.lineWidth = lw + 5;
    ctx.strokeStyle = mixSunColor(t, 1);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = alpha;
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

    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(xn, padTop);
    ctx.lineTo(xn, h - padBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    const idx = Math.round(u * (pts.length - 1));
    const p = pts[clamp(idx, 0, pts.length - 1)];
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(xn, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
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

  let focusRow = null;
  let context = { label: 'now' };

  if (dayIndex === 0) {
    focusRow = nearestNowRow(dayRows);
    context = { label: 'now' };
  } else {
    focusRow = nearestRowToLocalHour(dayRows, 12);
    context = { label: 'tomorrow ~12:00' };
  }

  renderDecision(focusRow, context);

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

  // Sunny minutes (today only)
  if (state.data.sun_minutes) {
    const todayMode = (dayIndex === 0);

    if (els.labelSun60) els.labelSun60.textContent = todayMode ? 'Sunny minutes next 1h' : 'Sunny minutes (today only)';
    if (els.labelSun120) els.labelSun120.textContent = todayMode ? 'Sunny minutes next 2h' : 'Sunny minutes (today only)';

    if (els.boxSun60) els.boxSun60.classList.toggle('dim', !todayMode);
    if (els.boxSun120) els.boxSun120.classList.toggle('dim', !todayMode);

    if (todayMode) {
      if (els.sun60) els.sun60.textContent = state.data.sun_minutes.next_1h ?? '—';
      if (els.sun120) els.sun120.textContent = state.data.sun_minutes.next_2h ?? '—';
      if (els.sun60) els.sun60.title = 'Sunny minutes from now (today)';
      if (els.sun120) els.sun120.title = 'Sunny minutes from now (today)';
    } else {
      if (els.sun60) els.sun60.textContent = '—';
      if (els.sun120) els.sun120.textContent = '—';
      if (els.sun60) els.sun60.title = 'Only available for Today';
      if (els.sun120) els.sun120.title = 'Only available for Today';
    }
  }

  const dayWin30 = daylightWindow(dayRows, 30);
  renderChart(dayRows, dayIndex, dayWin30);

  // Hide timeline if no daylight ahead (like before)
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

// --- Actions
function useDemo() {
  setLocation(52.3676, 4.9041, 'Amsterdam');
  fetchDay();
}

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
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      // show immediate feedback
      setLocation(lat, lon, 'My location');

      // reverse geocode -> CITY only
      try {
        const url =
          `https://api.bigdatacloud.net/data/reverse-geocode-client` +
          `?latitude=${encodeURIComponent(lat)}` +
          `&longitude=${encodeURIComponent(lon)}` +
          `&localityLanguage=en`;

        const res = await fetch(url);
        if (res.ok) {
          const j = await res.json();
          const city =
            j.city ||
            j.locality ||
            j.principalSubdivision ||
            j.localityInfo?.administrative?.[0]?.name ||
            '';

          if (city) setLocation(lat, lon, String(city).trim()); // <- replaces "My location"
        }
      } catch {
        // keep "My location"
      }

      await fetchDay();
    },
    () => {
      if (!silent) showError('Please allow location, or search for a city above.');
      setBusy(false);
      els.cityInput?.focus();
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// --- Wire up events
if (els.btnDemo) els.btnDemo.addEventListener('click', useDemo);
if (els.btnHere) els.btnHere.addEventListener('click', () => useHere());
if (els.btnRefresh) els.btnRefresh.addEventListener('click', () => fetchDay(true));
if (els.daySelect) els.daySelect.addEventListener('change', () => { if (state.data) render(); });

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

// Init
window.addEventListener('DOMContentLoaded', () => {
  loadRateLimitUntil();
  applyRateLimitUi();

  state.lat = null;
  state.lon = null;
  state.data = null;

  if (els.locPill) els.locPill.textContent = 'Choose a location';
  if (els.timePill) { els.timePill.textContent = '—'; els.timePill.title = ''; }

  useHere({ silent: false });
});
