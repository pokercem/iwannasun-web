'use strict';

  // CONFIG
  // Use same-origin in production (iwannasun.com) and fall back to a hosted API in dev.
  const API_BASE = 'https://iwannasun.onrender.com';

  const DEFAULT_THRESHOLD = 70; // product tuning constant (UI removed)
  const DAYS = 2;
  const DEFAULT_MODEL = 'ray';

  // Timeline limits (less clutter, faster)
  // timeline capped by sunset for Today
  const TIMELINE_MAX_ROWS = 84; // hard cap (10-min rows)

  // DOM REFS
  const locPill = document.getElementById('locPill');
  const timePill = document.getElementById('timePill');
  const cityInput = document.getElementById('cityInput');
  const cityResults = document.getElementById('cityResults');
  const errBox = document.getElementById('errBox');
  const loadingOverlay = document.getElementById('loadingOverlay');

  const btnHere = document.getElementById('btnHere');
  const btnDemo = document.getElementById('btnDemo');
  const btnRefresh = document.getElementById('btnRefresh');
  const daySelect = document.getElementById('daySelect');

  // Remaining DOM refs used by render()
  const decisionWrap = document.getElementById('decisionWrap');
  const decisionText = document.getElementById('decisionText');
  const decisionContext = document.getElementById('decisionContext');
  const whyInline = document.getElementById('whyInline');

  const labelScore = document.getElementById('labelScore');
  const labelConf = document.getElementById('labelConf');
  const labelSun60 = document.getElementById('labelSun60');
  const labelSun120 = document.getElementById('labelSun120');
  const boxSun60 = document.getElementById('boxSun60');
  const boxSun120 = document.getElementById('boxSun120');

  const scoreNow = document.getElementById('scoreNow');
  const confNow = document.getElementById('confNow');
  const sun60 = document.getElementById('sun60');
  const sun120 = document.getElementById('sun120');

  const nextWindow = document.getElementById('nextWindow');
  const nextWindowSub = document.getElementById('nextWindowSub');
  const sunriseEl = document.getElementById('sunriseTime');
  const sunsetEl = document.getElementById('sunsetTime');

  const timelineEl = document.getElementById('timeline');
  const yAxisEl = document.getElementById('yAxis');
  const xAxisEl = document.getElementById('xAxis');
  const canvas = document.getElementById('sunChart');
  const ctx = canvas ? canvas.getContext('2d') : null;

  // App state
  let state = { lat: null, lon: null, data: null, days: null, tzName: null, isBusy: false };

  // Abort in-flight /day requests when the user changes location rapidly.
  let _dayAbort = null;

  function setLocation(lat, lon, label = null) {
    state.lat = Number(lat);
    state.lon = Number(lon);
    state.data = null;
    state.days = null;
    state.tzName = null;

    if (locPill) locPill.textContent = (label && String(label).trim()) ? label : `${state.lat.toFixed(4)}, ${state.lon.toFixed(4)}`;
    if (timePill) { timePill.textContent = '—'; timePill.title = ''; }
    if (cityInput) cityInput.value = (label && label !== 'My location') ? label : '';
  }

  // CITY SEARCH
  let _cityTimer = null;
  let _lastCityQuery = '';
  let _lastCityResults = [];

  const hideCityResults = () => { if (!cityResults) return; cityResults.style.display = 'none'; cityResults.innerHTML = ''; };

  // PATCH: prevent HTML injection in city dropdown
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  const renderCityResults = (list) => {
    if (!cityResults) return;
    if (!list?.length) return hideCityResults();
    cityResults.innerHTML = list.map((r, idx) => {
      const name = esc(r.name || '—');
      const admin = r.admin1 ? `, ${esc(r.admin1)}` : '';
      const country = r.country ? `, ${esc(r.country)}` : '';
      let meta = `${admin}${country}`;
      if (meta.startsWith(', ')) meta = meta.slice(2);
      return `<div class="item" data-idx="${idx}"><div class="name">${name}</div><div class="meta">${meta}</div></div>`;
    }).join('');
    cityResults.style.display = 'block';
  };

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
      const results = data?.results || [];
      _lastCityResults = results;
      renderCityResults(results);
    } catch {
      hideCityResults();
    }
  }

  if (cityInput) {
    cityInput.addEventListener('input', (e) => {
      clearTimeout(_cityTimer);
      _cityTimer = setTimeout(() => searchCities(e.target.value), 220);
    });
    cityInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideCityResults();
      if (e.key === 'Enter' && _lastCityResults?.length) {
        const r = _lastCityResults[0];
        const label = `${r.name}${r.country ? ', ' + r.country : ''}`;
        setLocation(r.latitude, r.longitude, label);
        hideCityResults();
        fetchDay(true);
      }
    });
  }

  if (cityResults) {
    cityResults.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.item');
      if (!item) return;
      const idx = Number(item.getAttribute('data-idx'));
      const r = _lastCityResults[idx];
      if (!r) return;
      const label = `${r.name}${r.country ? ', ' + r.country : ''}`;
      setLocation(r.latitude, r.longitude, label);
      hideCityResults();
      fetchDay(true);
    });
  }

  document.addEventListener('click', (e) => {
    if (!cityResults || !cityInput) return;
    if (e.target === cityInput || cityResults.contains(e.target)) return;
    hideCityResults();
  });

  // UI HELPERS
  function setBusy(isBusy) {
    state.isBusy = !!isBusy;
    if (loadingOverlay) loadingOverlay.style.display = isBusy ? 'flex' : 'none';

    for (const el of [btnHere, btnDemo, btnRefresh, daySelect, cityInput].filter(Boolean)) {
      el.disabled = !!isBusy;
    }
    for (const el of [btnHere, btnDemo, btnRefresh].filter(Boolean)) {
      el.style.opacity = isBusy ? '0.65' : '1';
    }
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  // Small helpers
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // Format times in the *location* timezone (not the viewer's browser timezone).
  // Cache Intl.DateTimeFormat instances per timezone to avoid re-creating them on every render.
  const _fmtCache = new Map();

  function _getFormatters() {
    const tz = state?.tzName || '';
    if (_fmtCache.has(tz)) return _fmtCache.get(tz);
    const make = (opts) => {
      try {
        return new Intl.DateTimeFormat([], tz ? { ...opts, timeZone: tz } : opts);
      } catch {
        return new Intl.DateTimeFormat([], opts);
      }
    };
    const obj = {
      hm: make({ hour: '2-digit', minute: '2-digit' }),
      h: make({ hour: '2-digit' }),
      full: make({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    };
    _fmtCache.set(tz, obj);
    return obj;
  }

  const fmtTime = (v) => _getFormatters().hm.format(v instanceof Date ? v : new Date(v));
  const fmtHour = (v) => _getFormatters().h.format(v instanceof Date ? v : new Date(v));
  const fmtDateTime = (v) => _getFormatters().full.format(v instanceof Date ? v : new Date(v));
  const isDaylight = (r) => {
    if (!r) return false;
    if (typeof r.is_daylight === 'boolean') return r.is_daylight;
    return Number(r.elevation || 0) > 0;
  };
  const showError = (msg) => { if (!errBox) return; errBox.style.display = 'block'; errBox.textContent = msg; };
  const clearError = () => { if (!errBox) return; errBox.style.display = 'none'; errBox.textContent = ''; };


  // Timeline rows contain ISO strings; Date parsing is relatively expensive.
  // Cache Date objects on the row the first time we need them.
  function tLocal(r) {
    if (!r) return null;
    if (r._tLocal instanceof Date) return r._tLocal;
    const d = new Date(r.time_local);
    r._tLocal = d;
    r._tMs = d.getTime();
    return d;
  }
  const tMs = (r) => (r && typeof r._tMs === 'number') ? r._tMs : (tLocal(r)?.getTime() ?? NaN);


  function prepData(data) {
    if (!data?.timeline) return;
    const days = {};
    for (const r of data.timeline) {
      tLocal(r);
      const di = Number(r.day_index || 0);
      (days[di] ||= []).push(r);
    }
    state.days = days;
  }

  // Color mix: 0 -> cloudy blue, 1 -> sunny warm
  function mixSunColor(t, alpha = 1) {
    t = clamp(Number(t || 0), 0, 1);
    const a = { r: 0x9b, g: 0xbe, b: 0xd9 }; // #9bbed9 (cloudy)
    const b = { r: 0xf4, g: 0xb8, b: 0x60 }; // #f4b860 (sunny)
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    const aa = clamp(alpha, 0, 1);
    return `rgba(${r}, ${g}, ${bl}, ${aa})`;
  }

  function renderDecision(nowRow, context = { label: 'now', showMinutes: true }) {
    const whyEl = whyInline;

    if (!nowRow) {
      decisionText.textContent = '—';
      if (decisionWrap) decisionWrap.className = 'big';
      scoreNow.textContent = '—';
      confNow.textContent = '—';
      if (decisionContext) decisionContext.textContent = '';
      if (whyEl) whyEl.textContent = '';
      return;
    }

    // Context line + KPI labels
    const isNow = (context && context.label === 'now');
    if (decisionContext) decisionContext.textContent = isNow ? '' : `Based on ${context.label}`;
    if (labelScore) labelScore.textContent = isNow ? 'Sun score now' : 'Sun score';
    if (labelConf) labelConf.textContent = isNow ? 'Confidence now ⓘ' : 'Confidence ⓘ';

    const s = Number(nowRow.sun_score || 0);
    const c = Number(nowRow.confidence || 0);

    scoreNow.textContent = Math.round(s) + '%';
    scoreNow.className = 'value';

    if (!isDaylight(nowRow)) {
      confNow.textContent = '—';
      confNow.title = 'Sun below horizon (confidence not applicable).';
    } else {
      confNow.textContent = Math.round(c * 100) + '%';
      confNow.title = 'Confidence = how reliable the sun score estimate is (higher = more stable conditions).';
    }

    // Decision text is colored by actual sun intensity instead of categories
    const sunT = clamp(s/100,0,1);
    decisionText.textContent = (s >= DEFAULT_THRESHOLD) ? 'Sunny' : (s >= DEFAULT_THRESHOLD - 15 ? 'Mixed' : 'Blocked');
    if (decisionWrap) {
      decisionWrap.className = 'big';
      decisionWrap.style.color = mixSunColor(sunT, 1);
    }

    // WHY (short, decision-oriented)
    if (whyEl) {
      if (Number(nowRow.elevation || 0) <= 0) {
        whyEl.textContent = 'Sun below the horizon.';
      } else {
        const low = nowRow.cloud?.low ?? null;
        const mid = nowRow.cloud?.mid ?? null;
        const high = nowRow.cloud?.high ?? null;
        const precip = nowRow.cloud?.precip_mm ?? 0;

        let main = null;
        const parts = [];
        if (precip && precip > 0.2) parts.push('rain');

        const layers = [
          { name: 'low clouds', v: low },
          { name: 'mid clouds', v: mid },
          { name: 'high clouds', v: high },
        ].filter(x => typeof x.v === 'number');

        if (layers.length) {
          layers.sort((a,b) => b.v - a.v);
          if (layers[0].v >= 20) main = `${layers[0].name} (${Math.round(layers[0].v)}%)`;
        }
        if (main) parts.push(main);

        if (!parts.length) {
          whyEl.textContent = 'Clear sky and sun above the horizon.';
        } else {
          const prefix = (s >= DEFAULT_THRESHOLD) ? 'Clear despite ' : 'Mostly blocked by ';
          whyEl.textContent = prefix + parts.join(' + ') + '.';
        }
      }
    }
  }

  function renderNextWindow(win, label = null) {
    if (!win) {
      nextWindow.textContent = 'No sunny window';
      nextWindow.className = 'big bad';
      nextWindowSub.textContent = 'Try again later.';
      return;
    }

    const a = fmtTime(win.start);
    const b = fmtTime(win.end);

    nextWindow.textContent = `${a} – ${b}`;

    if (label) {
      nextWindowSub.textContent = label;
    }
    nextWindow.className = 'big good';

    const mins = (win.minutes != null) ? win.minutes : Math.max(0, Math.round((new Date(win.end) - new Date(win.start)) / 60000));
    if (!label) {
      nextWindowSub.textContent = `${mins} minutes above threshold`;
    }
  }

  function daylightWindow(dayRows, padMinutes = 30) {
    // Returns {start: Date, end: Date} where start is padMinutes before first sun-up,
    // and end is padMinutes after last sun-up. If no daylight, returns null.
    const rows = (dayRows || []);
    let first = null;
    let last = null;
    for (const r of rows) {
      if (isDaylight(r)) { first = tLocal(r); break; }
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      if (isDaylight(rows[i])) { last = tLocal(rows[i]); break; }
    }
    if (!first || !last) return null;
    const start = new Date(first.getTime() - padMinutes * 60000);
    const end = new Date(last.getTime() + padMinutes * 60000);
    return { start, end };
  }

  function renderTimeline(dayRows, dayIndex = 0, win = null) {
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
      const dt = tLocal(r);
      const inWin = win ? (dt >= win.start && dt <= win.end) : isDaylight(r);
      if (!inWin) continue;
      const ms = tMs(r);
      if (Number(dayIndex) === 0 && ms < nowMs) continue; // hide past (Today)
      if (Number(dayIndex) === 0 && ms > endMsToday) continue; // stop at sunset (Today)
      if (shown >= TIMELINE_MAX_ROWS) break; // hard cap

      const t = fmtTime(dt);
      const s = Math.round(Number(r.sun_score || 0));
      const c = isDaylight(r) ? Math.round(Number(r.confidence || 0) * 100) : null;

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

    timelineEl.innerHTML = parts.join('');
  }

  function renderChart(dayRows, dayIndex = 0, win = null) {
    if (!canvas || !ctx) return;

    const cssW = canvas.clientWidth || 900;
    const cssH = canvas.clientHeight || 220;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = cssW;
    const h = cssH;

    ctx.clearRect(0, 0, w, h);

    if (!dayRows || !dayRows.length) {
      if (yAxisEl) yAxisEl.innerHTML = '';
      if (xAxisEl) xAxisEl.innerHTML = '';
      return;
    }

    win = win || daylightWindow(dayRows, 30);
    if (!win) {
      if (yAxisEl) yAxisEl.innerHTML = '';
      if (xAxisEl) xAxisEl.innerHTML = '';
      return;
    }

    let startIdx = 0;
    let endIdx = dayRows.length - 1;
    for (let i = 0; i < dayRows.length; i++) {
      if (tLocal(dayRows[i]) >= win.start) { startIdx = Math.max(0, i); break; }
    }
    for (let i = dayRows.length - 1; i >= 0; i--) {
      if (tLocal(dayRows[i]) <= win.end) { endIdx = Math.min(dayRows.length - 1, i); break; }
    }

    const rows = dayRows.slice(startIdx, endIdx + 1);

    const elevs = rows.map(r => Math.max(0, Number(r.elevation || 0)));
    const maxElevRaw = Math.max(...elevs, 1);
    const maxElev = Math.max(10, Math.ceil(maxElevRaw / 10) * 10);

    if (yAxisEl) {
      const ticks = [];
      for (let d = maxElev; d >= 0; d -= 10) ticks.push(d);
      yAxisEl.innerHTML = ticks.map(d => `<div>${d}°</div>`).join('');
    }

    if (xAxisEl) {
      const t0 = tLocal(rows[0]);
      const t1 = tLocal(rows[rows.length - 1]);
      const steps = 4;
      const labels = [];
      for (let k = 0; k <= steps; k++) {
        const tt = new Date(t0.getTime() + (k / steps) * (t1 - t0));
        tt.setMinutes(0, 0, 0);
        labels.push(fmtTime(tt));
      }
      xAxisEl.innerHTML = labels.map(t => `<div>${t}</div>`).join('');
    }

    const padX = 14;
    const padTop = 14;
    const padBottom = 18;

    function yOf(e) {
      const usableH = h - padTop - padBottom;
      const yy = (h - padBottom) - (e / maxElev) * usableH;
      return clamp(yy, padTop, h - padBottom);
    }

    function xOf(i) {
      if (rows.length === 1) return w / 2;
      return padX + (i / (rows.length - 1)) * (w - 2 * padX);
    }

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
      return { x: xOf(i), y: yOf(e), e, s: Number(r.sun_score || 0), t: tLocal(r) };
    });

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

    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
      else ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.26)';
    ctx.stroke();

    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (!isDaylight({ elevation: a.e, is_daylight: a.e > 0 }) || !isDaylight({ elevation: b.e, is_daylight: b.e > 0 })) continue;

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

    const base = tLocal(rows[0]);
    const target = new Date(base);
    target.setHours(hour, 0, 0, 0);

    let best = rows[0];
    let bestDt = Infinity;
    for (const r of rows) {
      const t = tLocal(r);
      const dt = Math.abs(t - target);
      if (dt < bestDt) { bestDt = dt; best = r; }
    }
    return best;
  }

  // CACHE + API

  function cacheKey(lat, lon, threshold, { days = 2, model = DEFAULT_MODEL } = {}) {
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

  async function fetchDay(force = false) {
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

    // Patch: try ray first, but if it fails (often 502), fall back to local.
    // Patch: use mode=quick for Today (lightweight). For Tomorrow, use mode=full so the chart has daylight.
    const wantedMode = (Number(daySelect?.value || 0) === 0) ? 'quick' : 'full';

    const base = `${API_BASE}/day?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
      + `&threshold=${encodeURIComponent(threshold)}&days=${DAYS}&mode=${encodeURIComponent(wantedMode)}`;

    const urlRay = base + `&model=ray`;
    const urlLocal = base + `&model=local`;

    // Cache: keep the existing cache behavior, but if ray fails we may still use local.
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
      // Abort any previous request.
      if (_dayAbort) _dayAbort.abort();
      _dayAbort = new AbortController();
      const { signal } = _dayAbort;

      let usedModel = 'ray';
      let res = await fetch(urlRay, { signal });
      
      if (!res.ok) {
        // If backend says rate-limited, don't immediately hit it again with local.
        let msg = '';
        try { msg = (await res.json())?.detail || ''; } catch {}
        if (res.status === 503 && msg.toLowerCase().includes('rate limited')) {
          showError(msg);
          return;
        }
      
        // Otherwise fallback to local
        usedModel = 'local';
        res = await fetch(urlLocal, { signal });
      }

      if (!res.ok) {
        // Show backend-provided error detail if available.
        let msg = `API error ${res.status}`;
        try {
          const j = await res.json();
          if (j?.detail) msg = String(j.detail);
        } catch {
          // ignore
        }
        showError(msg);
        return;
      }

      const data = await res.json();
      state.data = data;
      state.tzName = data?.meta?.tz_name || null;
      prepData(state.data);

      // Save to cache under the configured MODEL key (simple; avoids extra cache complexity).
      saveCached(lat, lon, threshold, data, { days: DAYS, model: usedModel });
      render();
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.code === 20)) {
        return;
      }
      showError('Network error (could not reach API).');
      console.error(e);
    } finally {
      setBusy(false);
    }
  }

  // RENDER

  function render() {
    if (!state.data) return;

    if (timePill) {
      if (state.tzName) {
        timePill.textContent = fmtTime(new Date());
        timePill.title = `Local time (${state.tzName})`;
      } else {
        timePill.textContent = '—';
        timePill.title = '';
      }
    }

    const dayIndex = Number(daySelect?.value || 0);
    let dayRows = (state.days && state.days[dayIndex]) ? state.days[dayIndex] : null;
    if (!dayRows) {
      prepData(state.data);
      dayRows = (state.days && state.days[dayIndex]) ? state.days[dayIndex] : [];
    }

    let focusRow = null;
    let context = { label: 'now', showMinutes: true };

    if (dayIndex === 0) {
      focusRow = nearestNowRow(dayRows);
      context = { label: 'now', showMinutes: true };
    } else {
      focusRow = nearestRowToLocalHour(dayRows, 12);
      context = { label: 'tomorrow ~12:00', showMinutes: false };
    }

    renderDecision(focusRow, context);

    let win = state.data.next_sunny_window_by_day
      ? (state.data.next_sunny_window_by_day[String(dayIndex)] || null)
      : (state.data.next_sunny_window || null);

    if (dayIndex === 0 && !win && state.data.next_sunny_window_by_day) {
      const w1 = state.data.next_sunny_window_by_day["1"] || null;
      if (w1) {
        win = w1;
        renderNextWindow(win, 'Tomorrow');
      } else {
        renderNextWindow(null);
      }
    } else {
      renderNextWindow(win);
    }

    const dayWin = daylightWindow(dayRows, 0);
    if (sunriseEl && sunsetEl) {
      if (!dayWin) {
        sunriseEl.textContent = '—';
        sunsetEl.textContent = '—';
        sunriseEl.title = 'No sunrise (sun stays below horizon)';
        sunsetEl.title = 'No sunset (sun stays below horizon)';
      } else {
        sunriseEl.textContent = fmtTime(dayWin.start);
        sunsetEl.textContent = fmtTime(dayWin.end);
        sunriseEl.title = fmtDateTime(dayWin.start);
        sunsetEl.title = fmtDateTime(dayWin.end);
      }
    }

    if (state.data.sun_minutes) {
      const todayMode = (dayIndex === 0);

      if (labelSun60) labelSun60.textContent = todayMode ? 'Sunny minutes next 1h' : 'Sunny minutes (today only)';
      if (labelSun120) labelSun120.textContent = todayMode ? 'Sunny minutes next 2h' : 'Sunny minutes (today only)';

      if (boxSun60) boxSun60.classList.toggle('dim', !todayMode);
      if (boxSun120) boxSun120.classList.toggle('dim', !todayMode);

      if (todayMode) {
        sun60.textContent = state.data.sun_minutes.next_1h ?? '—';
        sun120.textContent = state.data.sun_minutes.next_2h ?? '—';
        sun60.title = 'Sunny minutes from now (today)';
        sun120.title = 'Sunny minutes from now (today)';
      } else {
        sun60.textContent = '—';
        sun120.textContent = '—';
        sun60.title = 'Only available for Today';
        sun120.title = 'Only available for Today';
      }
    }

    const dayWin30 = daylightWindow(dayRows, 30);

    renderChart(dayRows, dayIndex, dayWin30);

    const nowMs = Date.now();
    const hasDaylightAhead = (dayIndex === 0)
      ? (dayRows || []).some(r => isDaylight(r) && tMs(r) >= nowMs)
      : (dayRows || []).some(r => isDaylight(r));

    if (!hasDaylightAhead) {
      if (timelineEl) { timelineEl.style.display = 'none'; timelineEl.innerHTML = ''; }
    } else {
      if (timelineEl) timelineEl.style.display = 'block';
      renderTimeline(dayRows, dayIndex, dayWin30);
    }
  }

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
      if (cityInput) cityInput.focus();
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation(pos.coords.latitude, pos.coords.longitude, 'My location');
        fetchDay();
      },
      () => {
        if (!silent) showError('Please allow location, or search for a city above.');
        setBusy(false);
        if (cityInput) cityInput.focus();
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }
  if (btnDemo) btnDemo.addEventListener('click', useDemo);
  if (btnHere) btnHere.addEventListener('click', () => useHere());
  if (btnRefresh) btnRefresh.addEventListener('click', () => fetchDay(true));
  if (daySelect) daySelect.addEventListener('change', () => { if (state.data) render(); });

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

    window.addEventListener('DOMContentLoaded', function init() {
    state.lat = null;
    state.lon = null;
    state.data = null;

    if (locPill) locPill.textContent = 'Choose a location';
    if (timePill) { timePill.textContent = '—'; timePill.title = ''; }

    useHere({ silent: false });
    });

// end of app.js
