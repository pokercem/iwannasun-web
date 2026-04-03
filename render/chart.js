'use strict';

(function initChartRenderModule(global) {
  const LIGHT_CHART_COLORS = Object.freeze({
    gridStroke: 'rgba(20,24,28,0.12)',
    baseStroke: 'rgba(20,24,28,0.28)',
    nowStroke: 'rgba(20,24,28,0.24)',
    atmosphereTop: 'rgba(255,248,236,0.10)',
    atmosphereMid: 'rgba(255,255,255,0.03)',
    atmosphereBottom: 'rgba(255,255,255,0.00)',
    nowHalo: 'rgba(244,184,96,0.24)',
    nowDotFill: 'rgba(120,72,20,0.96)',
    nowDotStroke: 'rgba(120,72,20,0.62)',
    hoverGuide: 'rgba(20,24,28,0.28)',
    hoverDotFill: 'rgba(255,255,255,0.90)',
    tooltipFill: 'rgba(255,255,255,0.94)',
    tooltipStroke: 'rgba(20,24,28,0.10)',
    tooltipText: 'rgba(20,24,28,0.82)',
  });

  const DARK_CHART_COLORS = Object.freeze({
    gridStroke: 'rgba(0,0,0,0.10)',
    baseStroke: 'rgba(0,0,0,0.26)',
    nowStroke: 'rgba(0,0,0,0.22)',
    atmosphereTop: 'rgba(255,248,236,0.06)',
    atmosphereMid: 'rgba(255,255,255,0.015)',
    atmosphereBottom: 'rgba(255,255,255,0.00)',
    nowDotFill: 'rgba(255,244,226,0.95)',
    nowDotStroke: 'rgba(255,248,232,0.92)',
  });

  function chartAxisKeyForRows(rows, {
    tzName = '',
    maxElevOverride = null,
    maxElevationFromRows,
  } = {}) {
    const chartRows = rows || [];
    if (!chartRows.length) return '';

    let maxElev = maxElevOverride;
    if (!Number.isFinite(maxElev) && typeof maxElevationFromRows === 'function') {
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

  function renderChart({
    canvas,
    ctx,
    yAxisEl,
    xAxisEl,
    dayRows,
    win = null,
    rowsOverride = null,
    prevAxisKey = '',
    hover = null,
    tzName = '',
    daylightWindow,
    chartRowsForWindow,
    maxElevationFromRows,
    mixSunColor,
    clamp,
    fmtTime,
    tUtc,
  } = {}) {
    if (!canvas || !ctx) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width || canvas.clientWidth || 0));
    const cssH = Math.max(1, Math.round(rect.height || canvas.clientHeight || 0));
    if (cssW <= 1 || cssH <= 1) {
      return null;
    }

    const dpr = Math.min(2, global.devicePixelRatio || 1);
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = cssW;
    const h = cssH;
    ctx.clearRect(0, 0, w, h);

    function clearAxes() {
      if (yAxisEl) yAxisEl.innerHTML = '';
      if (xAxisEl) xAxisEl.innerHTML = '';
    }

    if (!dayRows || !dayRows.length) {
      clearAxes();
      return { axisKey: '', geom: null };
    }

    const dayWin = win || daylightWindow(dayRows, 30);
    if (!dayWin) {
      clearAxes();
      return { axisKey: '', geom: null };
    }

    const rows = rowsOverride || chartRowsForWindow(dayRows, dayWin);
    if (!rows.length) {
      clearAxes();
      return { axisKey: '', geom: null };
    }

    const elevs = rows.map((r) => Math.max(0, Number(r.elevation || 0)));
    const maxElevRaw = Math.max(...elevs, 1);
    const maxElev = Math.max(10, Math.ceil(maxElevRaw / 10) * 10);
    const axisKey = chartAxisKeyForRows(rows, {
      tzName,
      maxElevOverride: maxElev,
      maxElevationFromRows,
    });

    if (yAxisEl && axisKey !== prevAxisKey) {
      const ticks = [];
      for (let d = maxElev; d >= 0; d -= 10) ticks.push(d);
      yAxisEl.innerHTML = ticks.map((d) => `<div>${d}°</div>`).join('');
    }

    if (xAxisEl && axisKey !== prevAxisKey) {
      const t0 = tUtc(rows[0]);
      const t1 = tUtc(rows[rows.length - 1]);
      const steps = 4;
      const labels = [];
      for (let k = 0; k <= steps; k += 1) {
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
      xAxisEl.innerHTML = labels.map((t) => `<div>${t}</div>`).join('');
    }

    const padX = 14;
    const padTop = 14;
    const padBottom = 18;
    const lightAtmosphere = Boolean(document.body && !document.body.classList.contains('solarApiPage'));
    const palette = lightAtmosphere ? LIGHT_CHART_COLORS : DARK_CHART_COLORS;
    const { gridStroke, baseStroke, nowStroke } = palette;

    const yOf = (e) => {
      const usableH = h - padTop - padBottom;
      const yy = (h - padBottom) - (e / maxElev) * usableH;
      return clamp(yy, padTop, h - padBottom);
    };
    const xOf = (i) => rows.length === 1 ? w / 2 : padX + (i / (rows.length - 1)) * (w - 2 * padX);

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

    const geom = { w, padX, ptsLen: pts.length };

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
    atmosphereGrad.addColorStop(0, palette.atmosphereTop);
    atmosphereGrad.addColorStop(0.42, palette.atmosphereMid);
    atmosphereGrad.addColorStop(1, palette.atmosphereBottom);
    ctx.fillStyle = atmosphereGrad;
    ctx.fill();

    ctx.lineWidth = 2.3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 1) {
      if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
      else ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.strokeStyle = baseStroke;
    ctx.stroke();

    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
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

      ctx.fillStyle = LIGHT_CHART_COLORS.nowHalo;
      ctx.beginPath();
      ctx.arc(xn, p.y, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = palette.nowDotFill;
      ctx.beginPath();
      ctx.arc(xn, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = palette.nowDotStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(xn, p.y, 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (hover?.active && hover.idx >= 0 && hover.idx < pts.length) {
      const hp = pts[hover.idx];
      const t = clamp(Number(hp.s || 0) / 100, 0, 1);
      const dotColor = mixSunColor(t, 1);
      const label = `${fmtTime(hp.t)} · ${Math.round(hp.s)}%`;

      ctx.save();
      ctx.strokeStyle = LIGHT_CHART_COLORS.hoverGuide;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(hp.x, padTop);
      ctx.lineTo(hp.x, h - padBottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = LIGHT_CHART_COLORS.hoverDotFill;
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

      ctx.fillStyle = LIGHT_CHART_COLORS.tooltipFill;
      ctx.strokeStyle = LIGHT_CHART_COLORS.tooltipStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(tipX, tipY, tipW, tipH);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = LIGHT_CHART_COLORS.tooltipText;
      ctx.fillText(label, tipX + txPad, tipY + tipH / 2);
      ctx.restore();
    }

    return { axisKey, geom };
  }

  global.IWSRenderChart = {
    chartAxisKeyForRows,
    renderChart,
  };
})(window);
