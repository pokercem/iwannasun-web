'use strict';

(function registerAtmosphereTheme(global) {
  let lastAtmosThemeKey = '';

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function toNumberOrNaN(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function twilightBellAt(nowMs, centerMs, leftMinutes, rightMinutes) {
    if (!Number.isFinite(nowMs) || !Number.isFinite(centerMs)) return 0;
    const leftMs = Math.max(1, Number(leftMinutes || 0) * 60000);
    const rightMs = Math.max(1, Number(rightMinutes || 0) * 60000);
    const dt = nowMs - centerMs;
    if (dt < -leftMs || dt > rightMs) return 0;
    const norm = dt < 0 ? (-dt / leftMs) : (dt / rightMs);
    return 0.5 * (Math.cos(Math.PI * norm) + 1);
  }

  function hslToRgb(h, s, l) {
    const hh = ((Number(h) % 360) + 360) % 360;
    const ss = clamp(Number(s) / 100, 0, 1);
    const ll = clamp(Number(l) / 100, 0, 1);
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
    const m = ll - c / 2;
    let r1 = 0;
    let g1 = 0;
    let b1 = 0;
    if (hh < 60) {
      r1 = c;
      g1 = x;
    } else if (hh < 120) {
      r1 = x;
      g1 = c;
    } else if (hh < 180) {
      g1 = c;
      b1 = x;
    } else if (hh < 240) {
      g1 = x;
      b1 = c;
    } else if (hh < 300) {
      r1 = x;
      b1 = c;
    } else {
      r1 = c;
      b1 = x;
    }
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

  function resolveRowDate(row, tUtc) {
    if (typeof tUtc === 'function') return tUtc(row);
    const fallback = new Date(row?.time_utc || row?.t_utc || '');
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  function computeAtmosphericTheme(row, twilightContext = null, opts = {}) {
    const now = new Date();
    const score = clamp(toNumberOrNaN(row?.sun_score) || 0, 0, 100);
    const sunT = score / 100;
    const elev = toNumberOrNaN(row?.elevation);

    const rowDate = row ? resolveRowDate(row, opts.tUtc) : null;
    const refDate = (rowDate instanceof Date && !Number.isNaN(rowDate.getTime()))
      ? rowDate
      : now;
    const elevClamped = Number.isFinite(elev) ? clamp(elev, -10, 90) : 0;
    const isTomorrowSummary = Boolean(row && row._themeFallback === true);

    const dayHue = 205 - 10 * sunT;
    const daySat = 18 + 70 * sunT;
    const topL = 56 + 24 * sunT;
    const midL = 72 + 18 * sunT;
    const botL = 88 + 10 * sunT;

    const baseTop = { h: dayHue, s: clamp(daySat * 0.95, 0, 100), l: clamp(topL, 0, 100) };
    const baseMid = { h: dayHue, s: clamp(daySat * 0.75, 0, 100), l: clamp(midL, 0, 100) };
    const baseBottom = { h: dayHue, s: clamp(daySat * 0.36, 0, 100), l: clamp(botL, 0, 100) };

    const nightT = isTomorrowSummary ? 0 : clamp((0 - elevClamped) / 10, 0, 1);
    const nightAlpha = 0.55 * nightT;
    const nightTop = { h: 250, s: 55, l: 38, a: nightAlpha };
    const nightMid = { h: 248, s: 50, l: 45, a: nightAlpha };
    const nightBottom = { h: 245, s: 45, l: 58, a: nightAlpha };

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

  function applyAtmosphericTheme(row, twilightContext = null, opts = {}) {
    const doc = opts.document || global.document;
    if (!doc?.body || doc.body.classList.contains('solarApiPage')) return;
    const root = doc.documentElement;
    if (!root) return;
    const theme = computeAtmosphericTheme(row || null, twilightContext, opts);
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
    if (themeKey === lastAtmosThemeKey) return;
    lastAtmosThemeKey = themeKey;
    root.style.setProperty('--atm-sky-top', theme.skyTop);
    root.style.setProperty('--atm-sky-mid', theme.skyMid);
    root.style.setProperty('--atm-sky-bottom', theme.skyBottom);
    root.style.setProperty('--atm-tw-top', theme.twTop);
    root.style.setProperty('--atm-tw-mid', theme.twMid);
    root.style.setProperty('--atm-tw-bottom', theme.twBottom);
    root.style.setProperty('--atm-card', theme.card);
    root.style.setProperty('--atm-card-2', theme.card2);
  }

  function resetAtmosphericTheme() {
    lastAtmosThemeKey = '';
  }

  global.IWSAtmosphereTheme = {
    computeAtmosphericTheme,
    applyAtmosphericTheme,
    resetAtmosphericTheme,
  };
})(window);
