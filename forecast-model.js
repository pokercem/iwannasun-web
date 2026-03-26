'use strict';

(function initForecastModelModule(global) {
  class ForecastNormalizationError extends Error {
    constructor(message, details = null) {
      super(message);
      this.name = 'ForecastNormalizationError';
      this.details = details;
    }
  }

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function toTrimmedStringOrNull(value) {
    if (value == null) return null;
    const s = String(value).trim();
    return s ? s : null;
  }

  function toFiniteNumberOrFallback(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeClampedNumber(value, {
    fallback = 0,
    min = -Infinity,
    max = Infinity,
  } = {}) {
    return clamp(toFiniteNumberOrFallback(value, fallback), min, max);
  }

  function normalizeTimestamp(value) {
    if (value == null || value === '') return null;
    const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function normalizeForecastWindow(rawWindow) {
    if (!isPlainObject(rawWindow)) return null;
    const startDate = normalizeTimestamp(rawWindow.start);
    const endDate = normalizeTimestamp(rawWindow.end);
    if (!startDate || !endDate) return null;

    const startMs = startDate.getTime();
    const endMs = endDate.getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

    const minutesRaw = Number(rawWindow.minutes);
    const minutes = (Number.isFinite(minutesRaw) && minutesRaw >= 0)
      ? Math.round(minutesRaw)
      : Math.max(0, Math.round((endMs - startMs) / 60000));

    return {
      ...rawWindow,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      minutes,
    };
  }

  function normalizeForecastWindowMap(rawMap) {
    if (!isPlainObject(rawMap)) return null;
    const out = {};
    for (const [key, value] of Object.entries(rawMap)) {
      out[String(key)] = normalizeForecastWindow(value);
    }
    return out;
  }

  function normalizeCloudFields(rawCloud) {
    const cloud = isPlainObject(rawCloud) ? rawCloud : {};
    return {
      ...cloud,
      low: normalizeClampedNumber(cloud.low, { fallback: 0, min: 0, max: 100 }),
      mid: normalizeClampedNumber(cloud.mid, { fallback: 0, min: 0, max: 100 }),
      high: normalizeClampedNumber(cloud.high, { fallback: 0, min: 0, max: 100 }),
      precip_mm: Math.max(0, toFiniteNumberOrFallback(cloud.precip_mm, 0)),
    };
  }

  function normalizeDayIndex(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.trunc(n));
  }

  function isDaylightRow(row) {
    if (!row) return false;
    if (typeof row.is_daylight === 'boolean') return row.is_daylight;
    return Number(row.elevation || 0) > 0;
  }

  function tUtc(row) {
    if (!row) return null;
    if (row._tUtc instanceof Date) return row._tUtc;
    const src = row.time_utc || row.time_local;
    const d = new Date(src);
    row._tUtc = d;
    row._tMs = d.getTime();
    return d;
  }

  function tMs(row) {
    return (row && typeof row._tMs === 'number') ? row._tMs : (tUtc(row)?.getTime() ?? NaN);
  }

  function normalizeTimelineRow(rawRow, rowIndex = 0) {
    if (!isPlainObject(rawRow)) {
      throw new ForecastNormalizationError('Malformed forecast row: expected object.', { rowIndex });
    }

    const parsedUtc = normalizeTimestamp(rawRow.time_utc || rawRow.time_local);
    if (!parsedUtc) {
      throw new ForecastNormalizationError('Malformed forecast row: missing valid timestamp.', {
        rowIndex,
        time_utc: rawRow.time_utc ?? null,
        time_local: rawRow.time_local ?? null,
      });
    }

    const elevation = toFiniteNumberOrFallback(rawRow.elevation, 0);
    const confidence = normalizeClampedNumber(rawRow.confidence, { fallback: 0, min: 0, max: 1 });
    const sunScore = normalizeClampedNumber(rawRow.sun_score, { fallback: 0, min: 0, max: 100 });

    return {
      ...rawRow,
      day_index: normalizeDayIndex(rawRow.day_index),
      time_utc: parsedUtc.toISOString(),
      time_local: toTrimmedStringOrNull(rawRow.time_local),
      sun_score: sunScore,
      confidence,
      elevation,
      azimuth: toFiniteNumberOrFallback(rawRow.azimuth, 180),
      is_daylight: (typeof rawRow.is_daylight === 'boolean') ? rawRow.is_daylight : elevation > 0,
      cloud: normalizeCloudFields(rawRow.cloud),
      _tUtc: parsedUtc,
      _tMs: parsedUtc.getTime(),
    };
  }

  function bucketForecastRowsByDay(timelineRows) {
    const days = {};
    for (const row of (timelineRows || [])) {
      const dayIndex = normalizeDayIndex(row?.day_index);
      (days[dayIndex] ||= []).push(row);
    }
    for (const key of Object.keys(days)) {
      days[key].sort((a, b) => tMs(a) - tMs(b));
    }
    return days;
  }

  function normalizeForecastMeta(rawMeta) {
    const meta = isPlainObject(rawMeta) ? rawMeta : {};
    const intervalMinutes = toFiniteNumberOrFallback(meta.interval_minutes, 0);
    return {
      ...meta,
      tz_name: toTrimmedStringOrNull(meta.tz_name),
      interval_minutes: (Number.isFinite(intervalMinutes) && intervalMinutes > 0) ? intervalMinutes : 0,
    };
  }

  function normalizeForecastPayload(rawData) {
    if (!isPlainObject(rawData)) {
      throw new ForecastNormalizationError('Malformed forecast payload: expected object.');
    }
    if (!Array.isArray(rawData.timeline)) {
      throw new ForecastNormalizationError('Malformed forecast payload: timeline must be an array.');
    }

    const timeline = rawData.timeline.map((row, idx) => normalizeTimelineRow(row, idx));
    const days = bucketForecastRowsByDay(timeline);

    return {
      ...rawData,
      model: toTrimmedStringOrNull(rawData.model),
      meta: normalizeForecastMeta(rawData.meta),
      timeline,
      days,
      next_sunny_window: normalizeForecastWindow(rawData.next_sunny_window),
      next_sunny_window_by_day: normalizeForecastWindowMap(rawData.next_sunny_window_by_day),
    };
  }

  global.IWSForecastModel = {
    ForecastNormalizationError,
    isPlainObject,
    isDaylightRow,
    tUtc,
    tMs,
    normalizeForecastWindow,
    normalizeTimelineRow,
    normalizeForecastPayload,
    bucketForecastRowsByDay,
  };
})(window);
