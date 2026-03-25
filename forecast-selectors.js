'use strict';

(function initForecastSelectorsModule(global) {
  function createForecastSelectors({
    isDaylightRow,
    tUtc,
    tMs,
    localHourForDate,
    config = {},
  } = {}) {
    if (typeof isDaylightRow !== 'function'
      || typeof tUtc !== 'function'
      || typeof tMs !== 'function'
      || typeof localHourForDate !== 'function') {
      throw new Error('IWS forecast selectors require time/daylight helper dependencies.');
    }

    const DEFAULT_THRESHOLD = Number(config.DEFAULT_THRESHOLD || 70);
    const MEANINGFUL_WINDOW_MINUTES = Number(config.MEANINGFUL_WINDOW_MINUTES || 20);
    const SIDE_CARD_THRESHOLD = Number(config.SIDE_CARD_THRESHOLD || 60);
    const SIDE_CARD_MEANINGFUL_WINDOW_MINUTES = Number(config.SIDE_CARD_MEANINGFUL_WINDOW_MINUTES || 10);
    const TIMELINE_MAX_ROWS = Number(config.TIMELINE_MAX_ROWS || 84);

    function daylightWindow(dayRows, padMinutes = 30) {
      const rows = dayRows || [];
      let first = null;
      let last = null;

      for (const row of rows) {
        if (isDaylightRow(row)) {
          first = tUtc(row);
          break;
        }
      }
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (isDaylightRow(rows[i])) {
          last = tUtc(rows[i]);
          break;
        }
      }
      if (!first || !last) return null;

      return {
        start: new Date(first.getTime() - padMinutes * 60000),
        end: new Date(last.getTime() + padMinutes * 60000),
      };
    }

    function dayAverages(dayRows) {
      const rows = (dayRows || []).filter((row) => isDaylightRow(row));
      if (!rows.length) return null;

      let sumScore = 0;
      let sumConf = 0;
      let nScore = 0;
      let nConf = 0;
      let sumLow = 0;
      let sumMid = 0;
      let sumHigh = 0;
      let sumPrecip = 0;
      let nLow = 0;
      let nMid = 0;
      let nHigh = 0;
      let nPrecip = 0;

      for (const row of rows) {
        const score = Number(row.sun_score);
        if (Number.isFinite(score)) {
          sumScore += score;
          nScore += 1;
        }

        const confidence = Number(row.confidence);
        if (Number.isFinite(confidence)) {
          sumConf += confidence;
          nConf += 1;
        }

        const low = Number(row.cloud?.low);
        if (Number.isFinite(low)) {
          sumLow += low;
          nLow += 1;
        }

        const mid = Number(row.cloud?.mid);
        if (Number.isFinite(mid)) {
          sumMid += mid;
          nMid += 1;
        }

        const high = Number(row.cloud?.high);
        if (Number.isFinite(high)) {
          sumHigh += high;
          nHigh += 1;
        }

        const precip = Number(row.cloud?.precip_mm);
        if (Number.isFinite(precip)) {
          sumPrecip += precip;
          nPrecip += 1;
        }
      }

      const avgLow = nLow ? (sumLow / nLow) : 0;
      const avgMid = nMid ? (sumMid / nMid) : 0;
      const avgHigh = nHigh ? (sumHigh / nHigh) : 0;

      return {
        avgScore: nScore ? (sumScore / nScore) : 0,
        avgConf: nConf ? (sumConf / nConf) : 0,
        clouds: {
          low: avgLow,
          mid: avgMid,
          high: avgHigh,
          precip_mm: nPrecip ? (sumPrecip / nPrecip) : 0,
        },
        topLayer: [
          { name: 'low clouds', v: avgLow },
          { name: 'mid clouds', v: avgMid },
          { name: 'high clouds', v: avgHigh },
        ].sort((a, b) => b.v - a.v)[0],
      };
    }

    function timelineIntervalMinutes(dayRows, intervalMinutesHint = 0) {
      const rows = dayRows || [];
      if (rows.length >= 2) {
        const dt = Math.round((tMs(rows[1]) - tMs(rows[0])) / 60000);
        if (Number.isFinite(dt) && dt > 0) return dt;
      }
      const apiDt = Number(intervalMinutesHint || 0);
      if (Number.isFinite(apiDt) && apiDt > 0) return apiDt;
      return 10;
    }

    function meaningfulWindows(
      dayRows,
      threshold = DEFAULT_THRESHOLD,
      minMinutes = MEANINGFUL_WINDOW_MINUTES,
      intervalMinutesHint = 0
    ) {
      const rows = dayRows || [];
      if (!rows.length) return [];

      const intervalMinutes = timelineIntervalMinutes(rows, intervalMinutesHint);
      const minMs = minMinutes * 60000;
      const out = [];
      let startMs = null;
      let endMs = null;

      for (const row of rows) {
        const ok = isDaylightRow(row) && Number(row.sun_score || 0) >= threshold;
        const ms = tMs(row);

        if (ok && startMs == null) {
          startMs = ms;
          endMs = ms + intervalMinutes * 60000;
          continue;
        }
        if (ok && startMs != null) {
          endMs = ms + intervalMinutes * 60000;
          continue;
        }

        if (!ok && startMs != null && endMs != null) {
          if ((endMs - startMs) >= minMs) {
            out.push({
              start: new Date(startMs).toISOString(),
              end: new Date(endMs).toISOString(),
              minutes: Math.max(0, Math.round((endMs - startMs) / 60000)),
            });
          }
          startMs = null;
          endMs = null;
        }
      }

      if (startMs != null && endMs != null && (endMs - startMs) >= minMs) {
        out.push({
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          minutes: Math.max(0, Math.round((endMs - startMs) / 60000)),
        });
      }

      return out;
    }

    function pickSideWindowState(dayRows, tomorrowWin, nowMs = Date.now(), intervalMinutesHint = 0) {
      const wins = meaningfulWindows(
        dayRows,
        SIDE_CARD_THRESHOLD,
        SIDE_CARD_MEANINGFUL_WINDOW_MINUTES,
        intervalMinutesHint
      );
      const active = wins.find((win) => {
        const startMs = new Date(win.start).getTime();
        const endMs = new Date(win.end).getTime();
        return nowMs >= startMs && nowMs < endMs;
      });
      if (active) return { mode: 'active_today', win: active };

      const upcoming = wins.find((win) => new Date(win.start).getTime() > nowMs);
      if (upcoming) return { mode: 'next_today', win: upcoming };

      return { mode: 'fallback_tomorrow', win: tomorrowWin || null };
    }

    function chartRowsForWindow(dayRows, win = null) {
      if (!dayRows || !dayRows.length || !win) return [];

      let startIdx = 0;
      let endIdx = dayRows.length - 1;

      for (let i = 0; i < dayRows.length; i += 1) {
        if (tUtc(dayRows[i]) >= win.start) {
          startIdx = Math.max(0, i);
          break;
        }
      }
      for (let i = dayRows.length - 1; i >= 0; i -= 1) {
        if (tUtc(dayRows[i]) <= win.end) {
          endIdx = Math.min(dayRows.length - 1, i);
          break;
        }
      }

      if (endIdx < startIdx) return [];
      return dayRows.slice(startIdx, endIdx + 1);
    }

    function maxElevationFromRows(rows) {
      let maxElev = -Infinity;
      for (const row of rows || []) {
        const elevation = Number(row?.elevation);
        if (Number.isFinite(elevation) && elevation > maxElev) {
          maxElev = elevation;
        }
      }
      return maxElev;
    }

    function nearestNowRow(dayRows, nowMs = Date.now()) {
      let best = null;
      let bestDt = Infinity;
      for (const row of dayRows || []) {
        const dt = Math.abs(tMs(row) - nowMs);
        if (dt < bestDt) {
          bestDt = dt;
          best = row;
        }
      }
      return best;
    }

    function nearestRowToLocalHour(dayRows, hour = 12) {
      const rows = dayRows || [];
      if (!rows.length) return null;

      let best = rows[0];
      let bestDt = Infinity;
      for (const row of rows) {
        const dt = Math.abs(localHourForDate(tUtc(row)) - hour);
        if (dt < bestDt) {
          bestDt = dt;
          best = row;
        }
      }
      return best;
    }

    function buildTomorrowSyntheticDecisionRow(avg, anchor) {
      return {
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
    }

    function selectDecisionViewState(dayIndex, dayRows, chartMaxElevation, nowMs = Date.now()) {
      if (dayIndex === 0) {
        const focusRow = nearestNowRow(dayRows, nowMs);
        const themeRow = focusRow || nearestRowToLocalHour(dayRows, 12);
        return {
          source: 'today_now',
          isToday: true,
          isTomorrow: false,
          decisionRow: focusRow,
          contextLabel: 'now',
          chartMaxElevation,
          themeRow,
          score: Number(focusRow?.sun_score || 0),
          confidence: Number(focusRow?.confidence || 0),
        };
      }

      const avg = dayAverages(dayRows);
      if (!avg) {
        const fallback = nearestRowToLocalHour(dayRows, 12);
        const themeFallbackRow = fallback ? { ...fallback, _themeFallback: true } : fallback;
        return {
          source: 'tomorrow_no_daylight',
          isToday: false,
          isTomorrow: true,
          decisionRow: themeFallbackRow,
          contextLabel: 'tomorrow (no daylight)',
          chartMaxElevation,
          themeRow: themeFallbackRow,
          score: Number(themeFallbackRow?.sun_score || 0),
          confidence: Number(themeFallbackRow?.confidence || 0),
        };
      }

      const anchor = nearestRowToLocalHour(dayRows, 12);
      const synthetic = buildTomorrowSyntheticDecisionRow(avg, anchor);
      return {
        source: 'tomorrow_daylight_average',
        isToday: false,
        isTomorrow: true,
        decisionRow: synthetic,
        contextLabel: 'tomorrow (daylight average)',
        chartMaxElevation,
        themeRow: synthetic,
        score: Number(synthetic.sun_score || 0),
        confidence: Number(synthetic.confidence || 0),
      };
    }

    function selectSideCardViewState(dayIndex, dayRows, data, nowMs = Date.now(), intervalMinutesHint = 0) {
      const win = data?.next_sunny_window_by_day
        ? (data.next_sunny_window_by_day[String(dayIndex)] || null)
        : (data?.next_sunny_window || null);
      const tomorrowWin = data?.next_sunny_window_by_day
        ? (data.next_sunny_window_by_day['1'] || null)
        : null;

      if (dayIndex === 1) {
        return {
          mode: 'tomorrow_selected',
          activeWindow: null,
          nextWindow: win,
          tomorrowWindow: tomorrowWin,
          isFallbackTomorrow: false,
          win,
          heading: 'Tomorrow’s likely sun window',
          opts: {
            heading: 'Tomorrow’s likely sun window',
            emptySub: 'No meaningful window tomorrow.',
          },
        };
      }

      const side = pickSideWindowState(dayRows, tomorrowWin, nowMs, intervalMinutesHint);
      if (side.mode === 'active_today') {
        return {
          mode: side.mode,
          activeWindow: side.win,
          nextWindow: side.win,
          tomorrowWindow: tomorrowWin,
          isFallbackTomorrow: false,
          win: side.win,
          heading: 'Sunlight likely now',
          opts: {
            heading: 'Sunlight likely now',
            activeNow: true,
          },
        };
      }
      if (side.mode === 'next_today') {
        return {
          mode: side.mode,
          activeWindow: null,
          nextWindow: side.win,
          tomorrowWindow: tomorrowWin,
          isFallbackTomorrow: false,
          win: side.win,
          heading: 'Next likely sun window today',
          opts: {
            heading: 'Next likely sun window today',
          },
        };
      }
      return {
        mode: side.mode,
        activeWindow: null,
        nextWindow: side.win,
        tomorrowWindow: tomorrowWin,
        isFallbackTomorrow: true,
        win: side.win,
        heading: 'Tomorrow’s likely sun window',
        opts: {
          heading: 'Tomorrow’s likely sun window',
          emptySub: 'No meaningful window left today.',
        },
      };
    }

    function selectThemeViewState(dayIndex, dayWin, themeRow) {
      const useTwilightOverlay = dayIndex === 0;
      return {
        mode: useTwilightOverlay ? 'today_live' : 'summary_static',
        themeRow,
        twilightContext: (useTwilightOverlay && dayWin)
          ? { sunrise: dayWin.start, sunset: dayWin.end }
          : null,
        dayWin,
      };
    }

    function selectChartViewState(dayRows) {
      const dayWin = daylightWindow(dayRows, 0);
      const dayWin30 = daylightWindow(dayRows, 30);
      const chartRows = chartRowsForWindow(dayRows, dayWin30);
      return {
        dayRows,
        dayWin,
        dayWin30,
        chartRows,
        chartMaxElevation: maxElevationFromRows(chartRows),
      };
    }

    function visibleTimelineRows(dayRows, dayIndex, win, nowMs = Date.now()) {
      const rows = [];
      const endMsToday = win ? win.end.getTime() : Infinity;
      for (const row of dayRows || []) {
        const dt = tUtc(row);
        const inWin = win ? (dt >= win.start && dt <= win.end) : isDaylightRow(row);
        if (!inWin) continue;

        const ms = tMs(row);
        if (Number(dayIndex) === 0 && ms < nowMs) continue;
        if (Number(dayIndex) === 0 && ms > endMsToday) continue;

        rows.push(row);
        if (rows.length >= TIMELINE_MAX_ROWS) break;
      }
      return rows;
    }

    function selectTimelineViewState(dayIndex, dayRows, win, nowMs = Date.now()) {
      const hasDaylightAhead = Number(dayIndex) === 0
        ? (dayRows || []).some((row) => isDaylightRow(row) && tMs(row) >= nowMs)
        : (dayRows || []).some((row) => isDaylightRow(row));

      return {
        hasDaylightAhead,
        visibleRows: hasDaylightAhead ? visibleTimelineRows(dayRows, dayIndex, win, nowMs) : [],
        win,
      };
    }

    function deriveForecastRenderState({ data, days, dayIndex, nowMs = Date.now() }) {
      const dayRows = (days && days[dayIndex]) ? days[dayIndex] : [];
      const intervalMinutesHint = Number(data?.meta?.interval_minutes || 0);
      const chart = selectChartViewState(dayRows);
      const decision = selectDecisionViewState(dayIndex, dayRows, chart.chartMaxElevation, nowMs);
      const sideCard = selectSideCardViewState(dayIndex, dayRows, data, nowMs, intervalMinutesHint);
      const theme = selectThemeViewState(dayIndex, chart.dayWin, decision.themeRow);
      const timeline = selectTimelineViewState(dayIndex, dayRows, chart.dayWin30, nowMs);
      return {
        dayIndex,
        dayRows,
        chart,
        decision,
        sideCard,
        theme,
        timeline,
      };
    }

    return {
      daylightWindow,
      dayAverages,
      timelineIntervalMinutes,
      meaningfulWindows,
      pickSideWindowState,
      chartRowsForWindow,
      maxElevationFromRows,
      nearestNowRow,
      nearestRowToLocalHour,
      buildTomorrowSyntheticDecisionRow,
      selectDecisionViewState,
      selectSideCardViewState,
      selectThemeViewState,
      selectChartViewState,
      visibleTimelineRows,
      selectTimelineViewState,
      deriveForecastRenderState,
    };
  }

  global.IWSForecastSelectors = {
    createForecastSelectors,
  };
})(window);
