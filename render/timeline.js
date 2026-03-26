'use strict';

(function initTimelineRenderModule(global) {
  function renderTimeline({
    timelineEl,
    visibleRows,
    fmtTime,
    tUtc,
    isDaylightRow,
    mixSunColor,
    clamp,
  } = {}) {
    if (!timelineEl) return;

    const parts = [];
    parts.push(
      '<div class="trow trowHead muted small">'
        + '<div>Time</div><div title="Confidence">Conf.</div><div>Sun score</div></div>'
    );

    for (const row of (visibleRows || [])) {
      const dt = tUtc(row);
      const timeLabel = fmtTime(dt);
      const score = Math.round(Number(row.sun_score || 0));
      const confidence = isDaylightRow(row) ? Math.round(Number(row.confidence || 0) * 100) : null;

      const colorT = clamp(score / 100, 0, 1);
      const width = clamp(score, 0, 100);
      const opacity = (0.25 + 0.75 * colorT).toFixed(3);
      const color = mixSunColor(colorT, 1);
      const gradient = `linear-gradient(90deg, ${mixSunColor(0, 0.6)}, ${color})`;

      parts.push(
        '<div class="trow">'
          + `<div class="muted">${timeLabel}</div>`
          + `<div class="muted" title="Confidence in prediction">${confidence == null ? '—' : (confidence + '%')}</div>`
          + '<div>'
          + `<div class="scoreNum" style="color:${color}">${score}%</div>`
          + `<div class="bar"><div style="width:${width}%;background:${gradient};opacity:${opacity}"></div></div>`
          + '</div>'
          + '</div>'
      );
    }

    timelineEl.innerHTML = parts.join('');
  }

  function renderTimelineState({
    timelineEl,
    timelineState,
    fmtTime,
    tUtc,
    isDaylightRow,
    mixSunColor,
    clamp,
  } = {}) {
    if (!timelineEl) return;
    if (!timelineState?.hasDaylightAhead) {
      timelineEl.style.display = 'none';
      timelineEl.innerHTML = '';
      return;
    }

    timelineEl.style.display = 'block';
    renderTimeline({
      timelineEl,
      visibleRows: timelineState.visibleRows,
      fmtTime,
      tUtc,
      isDaylightRow,
      mixSunColor,
      clamp,
    });
  }

  global.IWSRenderTimeline = {
    renderTimeline,
    renderTimelineState,
  };
})(window);
