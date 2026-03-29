'use strict';

function isLocalLoopbackHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isLocalLoopback() {
  return isLocalLoopbackHost(location.hostname);
}

const API_BASE = isLocalLoopback() ? 'http://127.0.0.1:8000' : 'https://api.iwannasun.com';
const INTERNAL_TOKEN_STORAGE_KEY = 'iws_internal_access_token';
const CHART_PAD = { l: 12, r: 12, t: 10, b: 12 };
const CANDIDATE_LABELS = {
  a21_usable_sun_persistence_g008: 'A21 usable_sun_persistence_g008',
  practical_v12_1: 'practical_v12_1',
};

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
  unlockToken: $('unlockTokenInput'),
  unlockBtn: $('unlockBtn'),
  accessStatus: $('accessStatus'),
  runBtn: $('runBtn'),
  filterAllBtn: $('filterAllBtn'),
  filterChangedBtn: $('filterChangedBtn'),
  status: $('statusText'),
  metaCards: $('metaCards'),
  sourceTruthNote: $('sourceTruthNote'),
  mainYAxis: $('mainYAxis'),
  mainXAxis: $('mainXAxis'),
  compareChart: $('compareChart'),
  deltaChart: $('deltaChart'),
  changedHint: $('changedHint'),
  rowsBody: $('rowsBody'),
  selectedRowCard: $('selectedRowCard'),
  debugPayload: $('debugPayload'),
};

const state = {
  cities: [],
  compare: null,
  rowFilter: 'all',
  accessUnlocked: false,
  selectedRowIndex: null,
  chartRows: [],
};

function setStatus(text, isError = false) {
  if (!els.status) return;
  els.status.textContent = String(text || '');
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatNum(value, digits = 2) {
  return toNum(value, 0).toFixed(digits);
}

function formatSigned(value, digits = 0) {
  const num = toNum(value, 0);
  const fixed = digits > 0 ? num.toFixed(digits) : String(Math.round(num));
  return `${num > 0 ? '+' : ''}${fixed}`;
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
  return String(els.unlockToken?.value || '').trim();
}

function setInternalToken(token) {
  const clean = String(token || '').trim();
  if (els.unlockToken) els.unlockToken.value = clean;
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

function isChangedRow(row) {
  const scoreDelta = toNum(row?.rowDelta?.delta?.score ?? row?.delta?.score, 0);
  const confidenceDelta = toNum(row?.rowDelta?.delta?.confidence ?? row?.delta?.confidence, 0);
  const flags = row?.rowDelta?.flags || row?.flags;
  return Boolean(flags?.changed) || scoreDelta !== 0 || confidenceDelta !== 0;
}

function getTimelineRows(compare) {
  const production = compare?.production_result?.timeline || [];
  const candidate = compare?.candidate_result?.timeline || [];
  const rowDeltas = compare?.row_deltas || [];
  const rows = [];

  for (let i = 0; i < rowDeltas.length; i += 1) {
    if (!production[i] || !candidate[i]) continue;
    rows.push({
      idx: i,
      production: production[i],
      candidate: candidate[i],
      rowDelta: rowDeltas[i],
    });
  }
  return rows;
}

function getVisibleRows(compare) {
  const rows = getTimelineRows(compare);
  if (state.rowFilter === 'changed') return rows.filter(isChangedRow);
  return rows;
}

function findRowByIndex(compare, idx) {
  const rows = getTimelineRows(compare);
  return rows.find((row) => row.idx === idx) || null;
}

function ensureSelectedRow(compare) {
  if (!compare) {
    state.selectedRowIndex = null;
    return null;
  }
  const allRows = getTimelineRows(compare);
  if (!allRows.length) {
    state.selectedRowIndex = null;
    return null;
  }
  const existing = findRowByIndex(compare, state.selectedRowIndex);
  if (existing) return existing;
  const changed = allRows.find(isChangedRow);
  state.selectedRowIndex = (changed || allRows[0]).idx;
  return findRowByIndex(compare, state.selectedRowIndex);
}

function updateFilterButtons() {
  const showAll = state.rowFilter === 'all';
  els.filterAllBtn?.classList.toggle('active', showAll);
  els.filterChangedBtn?.classList.toggle('active', !showAll);
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

function drawLine(ctx, points, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.1;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
}

function renderMainChart(compare) {
  const rows = getVisibleRows(compare);
  state.chartRows = rows;

  const allRows = compare?.row_deltas || [];
  const changedCount = allRows.filter((row) => isChangedRow({ rowDelta: row })).length;
  if (els.changedHint) {
    const mode = state.rowFilter === 'all' ? 'showing all rows' : 'showing changed rows only';
    els.changedHint.textContent = `Changed rows: ${changedCount}/${allRows.length} (${mode}).`;
  }

  const { ctx, cssW, cssH } = configureCanvas(els.compareChart);
  if (!rows.length) {
    ctx.fillStyle = 'rgba(20, 26, 34, 0.64)';
    ctx.font = '12px ui-sans-serif, system-ui';
    ctx.fillText('No rows for the current filter.', 14, 22);
    renderMainAxes([]);
    return;
  }

  const w = cssW - CHART_PAD.l - CHART_PAD.r;
  const h = cssH - CHART_PAD.t - CHART_PAD.b;

  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.strokeStyle = 'rgba(20, 26, 34, 0.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = CHART_PAD.t + (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(CHART_PAD.l, y);
    ctx.lineTo(cssW - CHART_PAD.r, y);
    ctx.stroke();
  }

  const xFor = (i) => CHART_PAD.l + (w * i) / Math.max(1, rows.length - 1);
  const yFor = (score) => CHART_PAD.t + h - (h * clamp(toNum(score, 0), 0, 100)) / 100;

  const prodPts = rows.map((row, i) => ({ x: xFor(i), y: yFor(row.production.sun_score) }));
  const candPts = rows.map((row, i) => ({ x: xFor(i), y: yFor(row.candidate.sun_score) }));

  if (state.rowFilter === 'all') {
    ctx.fillStyle = 'rgba(215, 72, 72, 0.09)';
    rows.forEach((row, i) => {
      if (!isChangedRow(row)) return;
      const x = xFor(i);
      ctx.fillRect(Math.max(CHART_PAD.l, x - 2), CHART_PAD.t, 4, h);
    });
  }

  const selectedVisibleIndex = rows.findIndex((row) => row.idx === state.selectedRowIndex);
  if (selectedVisibleIndex >= 0) {
    const x = xFor(selectedVisibleIndex);
    ctx.strokeStyle = 'rgba(17, 24, 39, 0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, CHART_PAD.t);
    ctx.lineTo(x, cssH - CHART_PAD.b);
    ctx.stroke();
  }

  drawLine(ctx, prodPts, '#2e76ef');
  drawLine(ctx, candPts, '#eea93e');

  ctx.fillStyle = '#d74848';
  rows.forEach((row, i) => {
    if (!isChangedRow(row)) return;
    const point = candPts[i];
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.8, 0, Math.PI * 2);
    ctx.fill();
  });

  if (selectedVisibleIndex >= 0) {
    const prodPoint = prodPts[selectedVisibleIndex];
    const candPoint = candPts[selectedVisibleIndex];
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1.8;
    [prodPoint, candPoint].forEach((point) => {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  const times = rows.map((row) => row.production.time_local || row.production.time_utc);
  renderMainAxes(times);
}

function renderDeltaChart(compare) {
  const rows = getVisibleRows(compare);
  const { ctx, cssW, cssH } = configureCanvas(els.deltaChart);

  if (!rows.length) {
    ctx.fillStyle = 'rgba(20, 26, 34, 0.56)';
    ctx.font = '11px ui-sans-serif, system-ui';
    ctx.fillText('No rows for the current filter.', 12, 20);
    return;
  }

  const deltas = rows.map((row) => toNum(row.rowDelta?.delta?.score, 0));
  const maxAbs = Math.max(5, ...deltas.map((v) => Math.abs(v)));
  const yMin = -maxAbs;
  const yMax = maxAbs;
  const w = cssW - CHART_PAD.l - CHART_PAD.r;
  const h = cssH - CHART_PAD.t - CHART_PAD.b;

  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(0, 0, cssW, cssH);

  const xFor = (i) => CHART_PAD.l + (w * i) / Math.max(1, deltas.length - 1);
  const yFor = (value) => {
    const t = (toNum(value, 0) - yMin) / Math.max(1e-6, yMax - yMin);
    return CHART_PAD.t + h - t * h;
  };

  const yZero = yFor(0);
  ctx.strokeStyle = 'rgba(20, 26, 34, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(CHART_PAD.l, yZero);
  ctx.lineTo(cssW - CHART_PAD.r, yZero);
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
    if (!isChangedRow(row)) return;
    const x = xFor(i);
    const y = yFor(deltas[i]);
    ctx.beginPath();
    ctx.arc(x, y, 2.3, 0, Math.PI * 2);
    ctx.fill();
  });

  const selectedVisibleIndex = rows.findIndex((row) => row.idx === state.selectedRowIndex);
  if (selectedVisibleIndex >= 0) {
    const x = xFor(selectedVisibleIndex);
    const y = yFor(deltas[selectedVisibleIndex]);
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1.8;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(20, 26, 34, 0.62)';
  ctx.font = '11px ui-sans-serif, system-ui';
  ctx.fillText(`+${maxAbs}`, 8, CHART_PAD.t + 10);
  ctx.fillText('0', 8, yZero - 2);
  ctx.fillText(`${-maxAbs}`, 8, cssH - CHART_PAD.b - 2);
}

function buildTags(row) {
  const tags = [];
  const flags = row.rowDelta?.flags || {};
  if (flags.low_sun) tags.push('low_sun');
  if (flags.broken_cloud) tags.push('broken_cloud');
  if (flags.high_disagree) tags.push('high_disagree');
  if (row.rowDelta?.candidate?.triggered) tags.push('candidate_triggered');
  if (!tags.length) tags.push('none');
  return tags;
}

function renderRowsTable(compare) {
  const rows = getVisibleRows(compare)
    .slice()
    .sort((a, b) => {
      const deltaDiff = Math.abs(toNum(b.rowDelta?.delta?.score, 0)) - Math.abs(toNum(a.rowDelta?.delta?.score, 0));
      if (deltaDiff !== 0) return deltaDiff;
      return String(a.rowDelta?.time_local || '').localeCompare(String(b.rowDelta?.time_local || ''));
    })
    .slice(0, 24);

  els.rowsBody.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = 'No rows available for this filter.';
    tr.appendChild(td);
    els.rowsBody.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    if (row.idx === state.selectedRowIndex) tr.classList.add('selected');
    tr.addEventListener('click', () => {
      state.selectedRowIndex = row.idx;
      renderAll();
    });

    const delta = toNum(row.rowDelta?.delta?.score, 0);
    const cells = [
      new Date(row.rowDelta?.time_local || row.rowDelta?.time_utc).toLocaleString(),
      String(row.production.sun_score),
      String(row.candidate.sun_score),
      formatSigned(delta, 0),
      buildTags(row).join(', '),
    ];

    cells.forEach((text, idx) => {
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

function renderMetaCards(compare) {
  if (!compare) {
    els.metaCards.innerHTML = '<div class="metaCard placeholder">No compare loaded yet.</div>';
    return;
  }

  const meta = compare.meta || {};
  const slice = compare.slice_summary || {};
  const cards = [
    {
      label: 'Production',
      value: String(meta.production_scorer || 'unknown'),
      sub: 'Reported directly by /v1/day_compare as the active production scorer used for the production lane.',
    },
    {
      label: 'Candidate',
      value: CANDIDATE_LABELS[meta.candidate] || String(meta.candidate || 'unknown'),
      sub: `Explicit candidate request. Model=${meta.model || '-'} Mode=${meta.mode || '-'}.`,
    },
    {
      label: 'Location / Day',
      value: `${formatNum(meta.lat, 3)}, ${formatNum(meta.lon, 3)}`,
      sub: `${meta.date_local || '-'} · ${meta.tz_name || '-'} · ${meta.days || 0} day(s)`,
    },
    {
      label: 'Rows',
      value: `${meta.changed_rows || 0}/${meta.total_rows || 0}`,
      sub: `Changed rows / total rows. Threshold=${meta.threshold || 0}.`,
    },
    {
      label: 'Mean Delta',
      value: formatSigned(slice.weighted_mean_score_diff || 0, 2),
      sub: `Broken cloud mean delta ${formatSigned(slice.broken_cloud_mean_score_diff || 0, 2)}.`,
    },
    {
      label: 'Threshold Flips',
      value: `${compare.threshold_flip_summary?.total || 0}`,
      sub: `Up ${compare.threshold_flip_summary?.up || 0} · Down ${compare.threshold_flip_summary?.down || 0}`,
    },
    {
      label: 'Delta Bins',
      value: `${compare.score_delta_bins?.neg_ge5 || 0}/${compare.score_delta_bins?.pos_ge5 || 0}`,
      sub: 'Rows with large negative vs large positive score moves.',
    },
    {
      label: 'Trust Note',
      value: 'One compare payload',
      sub: 'This page does not synthesize scores locally. It only visualizes /v1/day_compare output.',
    },
  ];

  els.metaCards.innerHTML = cards.map((card) => `
    <article class="metaCard">
      <p class="metaLabel">${card.label}</p>
      <p class="metaValue">${card.value}</p>
      <p class="metaSub">${card.sub}</p>
    </article>
  `).join('');
}

function renderSelectedRow(compare) {
  const row = ensureSelectedRow(compare);
  if (!row) {
    els.selectedRowCard.innerHTML = '<p class="note">No row selected yet.</p>';
    return;
  }

  const production = row.production || {};
  const candidate = row.candidate || {};
  const delta = row.rowDelta?.delta || {};
  const flags = row.rowDelta?.flags || {};
  const tags = buildTags(row);

  els.selectedRowCard.innerHTML = `
    <div class="selectedHeadline">
      <div>
        <p class="selectedTime">${new Date(row.rowDelta?.time_local || row.rowDelta?.time_utc).toLocaleString()}</p>
        <p class="selectedSub">
          ${production.is_daylight ? 'Daylight' : 'Night'} · elevation ${formatNum(production.elevation, 1)}° · azimuth ${formatNum(production.azimuth, 1)}°
        </p>
      </div>
      <div class="pillRow">
        ${tags.map((tag) => `<span class="pill">${tag}</span>`).join('')}
      </div>
    </div>

    <div class="scoreCompare">
      <article class="scoreBox">
        <p class="scoreBoxLabel">Production</p>
        <p class="scoreBoxValue">${production.sun_score ?? 0}</p>
        <p class="scoreBoxSub">Confidence ${formatNum(production.confidence, 3)} · threshold ${row.rowDelta?.production?.meets_threshold ? 'met' : 'not met'}</p>
      </article>
      <article class="scoreBox">
        <p class="scoreBoxLabel">Candidate</p>
        <p class="scoreBoxValue">${candidate.sun_score ?? 0}</p>
        <p class="scoreBoxSub">Confidence ${formatNum(candidate.confidence, 3)} · ${row.rowDelta?.candidate?.triggered ? 'candidate rule triggered' : 'no explicit trigger flag'}</p>
      </article>
      <article class="scoreBox">
        <p class="scoreBoxLabel">Delta</p>
        <p class="scoreBoxValue">${formatSigned(delta.score, 0)}</p>
        <p class="scoreBoxSub">Threshold flip ${formatSigned(delta.threshold_flip, 0)} · direct flip ${formatSigned(delta.direct_flip, 0)}</p>
      </article>
    </div>

    <div class="keyGrid">
      <article class="keyCell">
        <p class="keyLabel">DNI / Clear DNI</p>
        <p class="keyValue">${formatNum(production.irradiance?.dni, 0)} / ${formatNum(production.irradiance?.dni_clear, 0)}</p>
      </article>
      <article class="keyCell">
        <p class="keyLabel">Cloud</p>
        <p class="keyValue">L ${formatNum(production.cloud?.low, 0)} · M ${formatNum(production.cloud?.mid, 0)} · H ${formatNum(production.cloud?.high, 0)}</p>
      </article>
      <article class="keyCell">
        <p class="keyLabel">Precip / Visibility</p>
        <p class="keyValue">${formatNum(production.cloud?.precip_mm, 2)} mm · ${production.cloud?.visibility_m ?? '-'} m</p>
      </article>
      <article class="keyCell">
        <p class="keyLabel">Flags</p>
        <p class="keyValue">${Object.entries(flags).filter(([, value]) => value).map(([key]) => key).join(', ') || 'none'}</p>
      </article>
    </div>
  `;
}

function renderAll() {
  updateFilterButtons();
  renderMetaCards(state.compare);
  renderMainChart(state.compare);
  renderDeltaChart(state.compare);
  renderRowsTable(state.compare);
  renderSelectedRow(state.compare);
  els.debugPayload.textContent = JSON.stringify(state.compare, null, 2);
}

function setRowFilter(mode) {
  state.rowFilter = mode === 'changed' ? 'changed' : 'all';
  renderAll();
}

function buildCompareRequest() {
  return {
    candidate: els.candidate.value,
    lat: Number(els.lat.value),
    lon: Number(els.lon.value),
    threshold: Number(els.threshold.value || 70),
    days: Number(els.days.value || 2),
    mode: els.mode.value,
    model: els.model.value,
  };
}

async function runCompare() {
  if (!state.accessUnlocked) {
    setStatus('Unlock compare first.', true);
    return;
  }

  const params = buildCompareRequest();
  if (!Number.isFinite(params.lat) || !Number.isFinite(params.lon)) {
    setStatus('Invalid latitude/longitude.', true);
    return;
  }

  setStatus('Loading compare payload...');
  els.runBtn.disabled = true;

  try {
    const compare = await fetchJson('/v1/day_compare', params);
    state.compare = compare;
    state.selectedRowIndex = null;
    renderAll();
    setStatus('Compare updated.');
  } catch (err) {
    setStatus(err?.message || 'Request failed.', true);
  } finally {
    els.runBtn.disabled = false;
  }
}

async function unlockDashboard() {
  if (isLocalLoopback()) {
    setAccessLocked(false);
    setAccessStatus('Local loopback access enabled.', 'ok');
    await runCompare();
    return;
  }

  const token = getInternalToken();
  if (!token) {
    setAccessStatus('Provide internal token to unlock.', 'error');
    return;
  }

  setInternalToken(token);
  setAccessLocked(false);
  setAccessStatus('Token loaded. Running compare…', 'ok');
  await runCompare();
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

function onCompareChartClick(event) {
  if (!state.chartRows.length) return;
  const rect = els.compareChart.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const w = rect.width - CHART_PAD.l - CHART_PAD.r;
  const clampedX = clamp(x, CHART_PAD.l, rect.width - CHART_PAD.r);
  const idx = Math.round(((clampedX - CHART_PAD.l) * Math.max(1, state.chartRows.length - 1)) / Math.max(1, w));
  const row = state.chartRows[clamp(idx, 0, state.chartRows.length - 1)];
  if (!row) return;
  state.selectedRowIndex = row.idx;
  renderAll();
}

function wireEvents() {
  els.citySearch?.addEventListener('input', onSearchInput);
  els.runBtn?.addEventListener('click', runCompare);
  els.candidate?.addEventListener('change', runCompare);
  els.unlockBtn?.addEventListener('click', unlockDashboard);
  els.unlockToken?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    unlockDashboard();
  });
  els.filterAllBtn?.addEventListener('click', () => setRowFilter('all'));
  els.filterChangedBtn?.addEventListener('click', () => setRowFilter('changed'));
  els.compareChart?.addEventListener('click', onCompareChartClick);
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

  if (isLocalLoopback()) {
    setAccessLocked(false);
    setAccessStatus('Local loopback access enabled.', 'ok');
    await runCompare();
    return;
  }

  if (getInternalToken()) {
    await unlockDashboard();
    return;
  }

  setAccessStatus('Locked. Add token to continue.');
  setStatus('Internal access required.');
}

init();
