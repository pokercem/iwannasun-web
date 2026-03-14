'use strict';

const API_BASE =
  location.hostname === '127.0.0.1' || location.hostname === 'localhost'
    ? 'http://127.0.0.1:8000'
    : 'https://api.iwannasun.com';
const INTERNAL_TOKEN_STORAGE_KEY = 'iws_internal_access_token';

const $ = (id) => document.getElementById(id);

const els = {
  citySearch: $('citySearch'),
  cityResults: $('cityResults'),
  candidate: $('candidateSelect'),
  lat: $('latInput'),
  lon: $('lonInput'),
  threshold: $('thresholdInput'),
  days: $('daysInput'),
  mode: $('modeSelect'),
  model: $('modelSelect'),
  since: $('sinceInput'),
  token: $('tokenInput'),
  unlockToken: $('unlockTokenInput'),
  unlockBtn: $('unlockBtn'),
  accessStatus: $('accessStatus'),
  runBtn: $('runBtn'),
  filterAllBtn: $('filterAllBtn'),
  filterChangedBtn: $('filterChangedBtn'),
  status: $('statusText'),
  mainYAxis: $('mainYAxis'),
  mainXAxis: $('mainXAxis'),
  compareChart: $('compareChart'),
  deltaChart: $('deltaChart'),
  changedHint: $('changedHint'),
  rowsBody: $('rowsBody'),
  debugPayload: $('debugPayload'),
};

const state = {
  cities: [],
  compare: null,
  summary: null,
  rowFilter: 'all',
  accessUnlocked: false,
};

function setStatus(text, isError = false) {
  if (!els.status) return;
  els.status.textContent = text;
  els.status.style.color = isError ? '#d74848' : 'rgba(20, 26, 34, 0.68)';
}

function setAccessStatus(text, tone = 'muted') {
  if (!els.accessStatus) return;
  els.accessStatus.textContent = String(text || '');
  els.accessStatus.classList.remove('error', 'ok');
  if (tone === 'error') els.accessStatus.classList.add('error');
  if (tone === 'ok') els.accessStatus.classList.add('ok');
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatNum(value, digits = 2) {
  return toNum(value, 0).toFixed(digits);
}

function parseLatLon(raw) {
  const match = String(raw || '').trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function getInternalToken() {
  const tokenFromUnlock = String(els.unlockToken?.value || '').trim();
  if (tokenFromUnlock) return tokenFromUnlock;
  return String(els.token?.value || '').trim();
}

function setInternalToken(token) {
  const clean = String(token || '').trim();
  if (els.unlockToken) els.unlockToken.value = clean;
  if (els.token) els.token.value = clean;
  if (clean) sessionStorage.setItem(INTERNAL_TOKEN_STORAGE_KEY, clean);
  else sessionStorage.removeItem(INTERNAL_TOKEN_STORAGE_KEY);
}

function consumeTokenFromUrl() {
  const url = new URL(location.href);
  const token = String(url.searchParams.get('token') || '').trim();
  if (!token) return '';
  url.searchParams.delete('token');
  const query = url.searchParams.toString();
  const cleaned = `${url.pathname}${query ? `?${query}` : ''}${url.hash || ''}`;
  history.replaceState({}, '', cleaned);
  return token;
}

function setAccessLocked(isLocked) {
  state.accessUnlocked = !isLocked;
  document.body.classList.toggle('locked', Boolean(isLocked));
}

function isChangedRow(row) {
  const scoreDelta = toNum(row?.delta?.score, 0);
  const confidenceDelta = toNum(row?.delta?.confidence, 0);
  return Boolean(row?.flags?.changed) || scoreDelta !== 0 || confidenceDelta !== 0;
}

function getVisibleRows(compare) {
  const timelineProd = compare?.production_result?.timeline || [];
  const timelineCand = compare?.candidate_result?.timeline || [];
  const rowDeltas = compare?.row_deltas || [];

  const rows = [];
  for (let i = 0; i < rowDeltas.length; i += 1) {
    const row = rowDeltas[i];
    const include = state.rowFilter === 'all' || isChangedRow(row);
    if (!include) continue;
    if (!timelineProd[i] || !timelineCand[i]) continue;
    rows.push({
      idx: i,
      production: timelineProd[i],
      candidate: timelineCand[i],
      rowDelta: row,
    });
  }
  return rows;
}

function updateFilterButtons() {
  if (!els.filterAllBtn || !els.filterChangedBtn) return;
  const showAll = state.rowFilter === 'all';
  els.filterAllBtn.classList.toggle('active', showAll);
  els.filterChangedBtn.classList.toggle('active', !showAll);
}

function requestHeaders() {
  const headers = {};
  const token = getInternalToken();
  if (token) headers['X-IWS-Internal-Token'] = token;
  return headers;
}

async function fetchJson(path, params) {
  const url = new URL(path, API_BASE);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === '' || value === null || value === undefined) return;
    url.searchParams.set(key, String(value));
  });

  const res = await fetch(url, { headers: requestHeaders() });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const message = payload?.error?.message || payload?.detail || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return payload;
}

function applyCity(city) {
  els.citySearch.value = city.city;
  els.lat.value = formatNum(city.lat, 4);
  els.lon.value = formatNum(city.lon, 4);
}

function renderCitySuggestions(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !state.cities.length) {
    els.cityResults.innerHTML = '';
    return;
  }

  const picks = state.cities
    .filter((city) => String(city.city || '').toLowerCase().includes(q))
    .slice(0, 8);

  els.cityResults.innerHTML = '';
  picks.forEach((city) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'city-chip';
    btn.textContent = `${city.city} (${formatNum(city.lat, 2)}, ${formatNum(city.lon, 2)})`;
    btn.addEventListener('click', () => {
      applyCity(city);
      els.cityResults.innerHTML = '';
    });
    els.cityResults.appendChild(btn);
  });
}

async function loadCities() {
  try {
    const res = await fetch('/data/cities.json');
    const cities = await res.json();
    if (Array.isArray(cities)) {
      state.cities = cities.filter((c) => Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon)));
    }
  } catch {
    state.cities = [];
  }
}

function renderMainAxes(times) {
  const yTicks = [100, 75, 50, 25, 0];
  els.mainYAxis.innerHTML = '';
  yTicks.forEach((tick) => {
    const span = document.createElement('span');
    span.textContent = String(tick);
    els.mainYAxis.appendChild(span);
  });

  els.mainXAxis.innerHTML = '';
  if (!times.length) return;
  const tickCount = Math.min(6, times.length);
  for (let i = 0; i < tickCount; i += 1) {
    const idx = Math.round((i / Math.max(1, tickCount - 1)) * (times.length - 1));
    const t = new Date(times[idx]);
    const label = document.createElement('span');
    label.textContent = Number.isNaN(t.getTime()) ? '-' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    els.mainXAxis.appendChild(label);
  }
}

function configureCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 860;
  const cssH = canvas.clientHeight || 240;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return { ctx, cssW, cssH };
}

function renderMainChart(compare) {
  const visibleRows = getVisibleRows(compare);
  const allRows = compare?.row_deltas || [];
  if (els.changedHint) {
    const changedCount = allRows.filter(isChangedRow).length;
    const totalCount = allRows.length;
    const mode = state.rowFilter === 'all' ? 'showing all rows' : 'showing changed rows only';
    els.changedHint.textContent = `Changed rows: ${changedCount}/${totalCount} (${mode}).`;
  }

  const { ctx, cssW, cssH } = configureCanvas(els.compareChart);
  if (!visibleRows.length) {
    ctx.fillStyle = 'rgba(20, 26, 34, 0.64)';
    ctx.font = '12px ui-sans-serif, system-ui';
    ctx.fillText('No changed rows for this request.', 14, 22);
    renderMainAxes([]);
    return;
  }

  const pad = { l: 12, r: 12, t: 10, b: 12 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;

  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.strokeStyle = 'rgba(20, 26, 34, 0.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.t + (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(cssW - pad.r, y);
    ctx.stroke();
  }

  const xFor = (i) => pad.l + (w * i) / Math.max(1, visibleRows.length - 1);
  const yFor = (score) => pad.t + h - (h * Math.max(0, Math.min(100, toNum(score)))) / 100;

  const prodPts = visibleRows.map((row, i) => ({ x: xFor(i), y: yFor(row.production.sun_score) }));
  const candPts = visibleRows.map((row, i) => ({ x: xFor(i), y: yFor(row.candidate.sun_score) }));

  const drawLine = (pts, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.1;
    ctx.beginPath();
    pts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  };

  drawLine(prodPts, '#2e76ef');
  drawLine(candPts, '#f4b860');

  const changedIndexes = visibleRows
    .map((row, i) => (isChangedRow(row.rowDelta) ? i : -1))
    .filter((i) => i >= 0);

  if (state.rowFilter === 'all') {
    ctx.fillStyle = 'rgba(215, 72, 72, 0.09)';
    changedIndexes.forEach((index) => {
      const x = xFor(index);
      ctx.fillRect(Math.max(pad.l, x - 2), pad.t, 4, h);
    });
  }

  ctx.fillStyle = '#d74848';
  changedIndexes.forEach((i) => {
    const p = candPts[i];
    if (!p) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.8, 0, Math.PI * 2);
    ctx.fill();
  });

  const times = visibleRows.map((row) => row.production.time_local || row.production.time_utc);
  renderMainAxes(times);
}

function renderDeltaChart(compare) {
  const rows = getVisibleRows(compare);
  const { ctx, cssW, cssH } = configureCanvas(els.deltaChart);
  if (!rows.length) {
    ctx.fillStyle = 'rgba(20, 26, 34, 0.56)';
    ctx.font = '11px ui-sans-serif, system-ui';
    ctx.fillText('No rows for current filter.', 12, 20);
    return;
  }

  const deltas = rows.map((row) => toNum(row?.rowDelta?.delta?.score, 0));
  const maxAbs = Math.max(5, ...deltas.map((v) => Math.abs(v)));
  const yMin = -maxAbs;
  const yMax = maxAbs;

  const pad = { l: 12, r: 12, t: 10, b: 12 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;

  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(0, 0, cssW, cssH);

  const xFor = (i) => pad.l + (w * i) / Math.max(1, deltas.length - 1);
  const yFor = (value) => {
    const t = (toNum(value, 0) - yMin) / Math.max(1e-6, yMax - yMin);
    return pad.t + h - t * h;
  };

  const yZero = yFor(0);
  ctx.strokeStyle = 'rgba(20, 26, 34, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, yZero);
  ctx.lineTo(cssW - pad.r, yZero);
  ctx.stroke();

  ctx.strokeStyle = '#1e2f4d';
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  deltas.forEach((value, i) => {
    const x = xFor(i);
    const y = yFor(value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = '#d74848';
  rows.forEach((row, i) => {
    if (!isChangedRow(row.rowDelta)) return;
    const x = xFor(i);
    const y = yFor(deltas[i]);
    ctx.beginPath();
    ctx.arc(x, y, 2.3, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = 'rgba(20, 26, 34, 0.62)';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.fillText(`+${maxAbs}`, 8, pad.t + 10);
  ctx.fillText('0', 8, yZero - 2);
  ctx.fillText(`${-maxAbs}`, 8, cssH - pad.b - 2);
}

function renderDebugTable(compare) {
  const rows = getVisibleRows(compare).map((row) => row.rowDelta);
  els.rowsBody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = 'No changed rows to display for this request.';
    tr.appendChild(td);
    els.rowsBody.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    if (isChangedRow(row)) tr.classList.add('row-changed');
    const delta = toNum(row?.delta?.score, 0);
    const values = [
      new Date(row.time_local || row.time_utc).toLocaleString(),
      String(row?.production?.sun_score ?? 0),
      String(row?.candidate?.sun_score ?? 0),
      `${delta > 0 ? '+' : ''}${delta}`,
      String(Boolean(row?.flags?.low_sun)),
      String(Boolean(row?.flags?.broken_cloud)),
      String(Boolean(row?.flags?.high_disagree)),
    ];

    values.forEach((text, idx) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (idx === 3) {
        if (delta > 0) td.className = 'delta-up';
        else if (delta < 0) td.className = 'delta-down';
      }
      tr.appendChild(td);
    });

    els.rowsBody.appendChild(tr);
  });
}

async function refreshSummary() {
  const summary = await fetchJson('/v1/shadow_summary', {
    candidate: els.candidate.value,
    since: els.since.value,
  });
  state.summary = summary;
  return summary;
}

async function verifyInternalAccess() {
  const token = getInternalToken();
  if (!token) {
    throw new Error('Internal token required.');
  }
  await fetchJson('/v1/shadow_summary', {
    candidate: els.candidate.value || 'practical_v12_1',
    since: '1h',
  });
}

function renderAll() {
  updateFilterButtons();
  renderMainChart(state.compare);
  renderDeltaChart(state.compare);
  renderDebugTable(state.compare);
  els.debugPayload.textContent = JSON.stringify({ compare: state.compare, summary: state.summary }, null, 2);
}

function setRowFilter(mode) {
  state.rowFilter = mode === 'changed' ? 'changed' : 'all';
  if (!state.compare) {
    updateFilterButtons();
    return;
  }
  renderAll();
}

async function runCompare() {
  if (!state.accessUnlocked) {
    setStatus('Unlock dashboard first.', true);
    return;
  }
  const lat = Number(els.lat.value);
  const lon = Number(els.lon.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    setStatus('Invalid latitude/longitude.', true);
    return;
  }

  setStatus('Loading visual compare...');
  els.runBtn.disabled = true;

  try {
    const compare = await fetchJson('/v1/day_compare', {
      candidate: els.candidate.value,
      lat,
      lon,
      threshold: Number(els.threshold.value || 70),
      days: Number(els.days.value || 2),
      mode: els.mode.value,
      model: els.model.value,
    });

    state.compare = compare;
    let summaryWarning = '';
    try {
      await refreshSummary();
    } catch (err) {
      state.summary = { error: String(err?.message || 'shadow summary unavailable') };
      summaryWarning = ' (shadow summary unavailable)';
    }
    renderAll();
    setStatus(`Updated${summaryWarning}.`);
  } catch (err) {
    setStatus(err?.message || 'Request failed.', true);
  } finally {
    els.runBtn.disabled = false;
  }
}

async function unlockDashboard() {
  const token = getInternalToken();
  if (!token) {
    setAccessStatus('Provide internal token to unlock.', 'error');
    return;
  }
  setInternalToken(token);
  setAccessStatus('Verifying internal access...');
  try {
    await verifyInternalAccess();
    setAccessLocked(false);
    setAccessStatus('Access granted.', 'ok');
    await runCompare();
  } catch (err) {
    setAccessLocked(true);
    setStatus('Internal access required.', true);
    setAccessStatus(String(err?.message || 'Access denied.'), 'error');
  }
}

function onSearchInput() {
  const raw = els.citySearch.value;
  const direct = parseLatLon(raw);
  if (direct) {
    els.lat.value = formatNum(direct.lat, 4);
    els.lon.value = formatNum(direct.lon, 4);
    els.cityResults.innerHTML = '';
    return;
  }
  renderCitySuggestions(raw);
}

function wireEvents() {
  els.citySearch.addEventListener('input', onSearchInput);
  els.runBtn.addEventListener('click', runCompare);
  els.candidate.addEventListener('change', runCompare);
  els.unlockBtn?.addEventListener('click', unlockDashboard);
  els.unlockToken?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    unlockDashboard();
  });
  els.token?.addEventListener('input', () => {
    if (!els.unlockToken) return;
    els.unlockToken.value = String(els.token.value || '');
  });
  els.filterAllBtn?.addEventListener('click', () => setRowFilter('all'));
  els.filterChangedBtn?.addEventListener('click', () => setRowFilter('changed'));
  window.addEventListener('resize', () => {
    if (!state.compare) return;
    renderMainChart(state.compare);
    renderDeltaChart(state.compare);
  });
}

async function init() {
  setAccessLocked(true);
  wireEvents();
  await loadCities();
  const tokenFromUrl = consumeTokenFromUrl();
  const storedToken = String(sessionStorage.getItem(INTERNAL_TOKEN_STORAGE_KEY) || '').trim();
  setInternalToken(tokenFromUrl || storedToken);
  if (getInternalToken()) {
    await unlockDashboard();
    return;
  }
  setAccessStatus('Locked. Add token to continue.');
  setStatus('Internal access required.');
}

init();
