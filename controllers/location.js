'use strict';

(function registerLocationController(global) {
  function createLocationController(opts) {
    const {
      els,
      state,
      roundCoord,
      coordStateDecimals,
      clearForecastUi,
      fetchDay,
      showError,
      setBusy,
      nextPaint,
    } = opts;

    let attached = false;
    let locationSeq = 0;
    let cityTimer = null;
    let lastCityQuery = '';
    let lastCityResults = [];
    let cityActiveIndex = -1;
    let citySearchSeq = 0;
    let activeCitySearchSeq = 0;

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c]));
    }

    function updateClearLocationButton() {
      if (!els.btnClearLocation || !els.cityInput) return;
      const hasValue = String(els.cityInput.value || '').trim().length > 0;
      els.btnClearLocation.hidden = !hasValue;
      els.btnClearLocation.disabled = !hasValue;
    }

    function setLocation(lat, lon, label = '') {
      locationSeq += 1;
      state.lat = roundCoord(lat, coordStateDecimals);
      state.lon = roundCoord(lon, coordStateDecimals);
      state.label = (label || '').trim();

      state.data = null;
      state.days = null;
      state.tzName = null;

      if (els.timePill) {
        els.timePill.textContent = '—';
        els.timePill.title = '';
      }
      if (els.cityInput) {
        els.cityInput.value = (state.label && state.label !== 'My location') ? state.label : '';
      }
      updateClearLocationButton();
      clearForecastUi();
    }

    function hideCityResults() {
      if (!els.cityResults) return;
      els.cityResults.style.display = 'none';
      els.cityResults.innerHTML = '';
      cityActiveIndex = -1;
      if (els.cityInput) els.cityInput.setAttribute('aria-expanded', 'false');
    }

    function renderCityResults(list) {
      if (!els.cityResults) return;
      if (!list?.length) return hideCityResults();

      els.cityResults.innerHTML = list.map((row, idx) => {
        const name = esc(row.name || '—');
        const admin = row.admin1 ? `, ${esc(row.admin1)}` : '';
        const country = row.country ? `, ${esc(row.country)}` : '';
        let meta = `${admin}${country}`;
        if (meta.startsWith(', ')) meta = meta.slice(2);

        const active = idx === cityActiveIndex ? ' active' : '';
        return `<div class="item${active}" role="option" aria-selected="${idx === cityActiveIndex}" data-idx="${idx}">
      <div class="name">${name}</div>
      <div class="meta">${meta}</div>
    </div>`;
      }).join('');

      els.cityResults.style.display = 'block';
      if (els.cityInput) els.cityInput.setAttribute('aria-expanded', 'true');
    }

    async function searchCities(q) {
      const reqSeq = ++citySearchSeq;
      activeCitySearchSeq = reqSeq;
      const isCurrent = () => reqSeq === activeCitySearchSeq;

      const query = (q || '').trim();
      if (query.length < 2) return hideCityResults();
      if (query === lastCityQuery) return;
      lastCityQuery = query;

      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`;
      try {
        const res = await fetch(url);
        if (!isCurrent()) return;
        if (!res.ok) throw new Error('geocoding failed');
        const data = await res.json();
        if (!isCurrent()) return;
        lastCityResults = data?.results || [];
        cityActiveIndex = -1;
        renderCityResults(lastCityResults);
      } catch {
        if (!isCurrent()) return;
        hideCityResults();
      }
    }

    function chooseCityResult(row) {
      if (!row) return;
      const label = `${row.name || ''}`.trim() || '—';
      setLocation(row.latitude, row.longitude, label);
      hideCityResults();
      fetchDay(false);
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
          const lat = roundCoord(pos.coords.latitude, coordStateDecimals);
          const lon = roundCoord(pos.coords.longitude, coordStateDecimals);

          setLocation(lat, lon, 'My location');
          const reverseGeocodeSeq = locationSeq;

          fetchDay(false);

          (async () => {
            try {
              const url =
                `https://api.bigdatacloud.net/data/reverse-geocode-client` +
                `?latitude=${encodeURIComponent(lat)}` +
                `&longitude=${encodeURIComponent(lon)}` +
                `&localityLanguage=en`;

              const res = await fetch(url);
              if (!res.ok) return;

              const data = await res.json();
              const city =
                data.city ||
                data.locality ||
                data.principalSubdivision ||
                data.localityInfo?.administrative?.[0]?.name ||
                '';

              if (city) {
                if (reverseGeocodeSeq !== locationSeq) return;
                if (state.lat !== lat || state.lon !== lon) return;
                state.label = String(city).trim();
                if (els.cityInput) els.cityInput.value = state.label;
                updateClearLocationButton();
              }
            } catch {
              // Ignore reverse geocode failures and keep the optimistic label.
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

    function getPresetLocation() {
      const raw = global.IWS_PRESET_LOCATION;
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

    function attach() {
      if (attached) return;
      attached = true;

      if (els.cityInput) {
        els.cityInput.addEventListener('input', (e) => {
          updateClearLocationButton();
          clearTimeout(cityTimer);
          cityTimer = setTimeout(() => searchCities(e.target.value), 220);
        });

        els.cityInput.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            hideCityResults();
            return;
          }

          if (e.key === 'ArrowDown' && lastCityResults.length) {
            e.preventDefault();
            cityActiveIndex = Math.max(0, Math.min(cityActiveIndex + 1, lastCityResults.length - 1));
            renderCityResults(lastCityResults);
            return;
          }

          if (e.key === 'ArrowUp' && lastCityResults.length) {
            e.preventDefault();
            cityActiveIndex = Math.max(-1, Math.min(cityActiveIndex - 1, lastCityResults.length - 1));
            renderCityResults(lastCityResults);
            return;
          }

          if (e.key === 'Enter' && lastCityResults?.length) {
            e.preventDefault();
            const row = (cityActiveIndex >= 0) ? lastCityResults[cityActiveIndex] : lastCityResults[0];
            chooseCityResult(row);
          }
        });
      }

      if (els.btnClearLocation) {
        els.btnClearLocation.addEventListener('click', () => {
          if (!els.cityInput) return;
          els.cityInput.value = '';
          hideCityResults();
          updateClearLocationButton();
          els.cityInput.focus();
          els.cityInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }

      if (els.cityResults) {
        els.cityResults.addEventListener('pointerdown', (e) => {
          const item = e.target.closest('.item');
          if (!item) return;
          const idx = Number(item.getAttribute('data-idx'));
          chooseCityResult(lastCityResults[idx]);
        });
      }

      document.addEventListener('click', (e) => {
        if (!els.cityResults || !els.cityInput) return;
        if (e.target === els.cityInput || els.cityResults.contains(e.target)) return;
        hideCityResults();
      });

      if (els.btnHere) {
        els.btnHere.addEventListener('click', () => useHere());
      }
    }

    return {
      attach,
      getPresetLocation,
      setLocation,
      updateClearLocationButton,
      useHere,
    };
  }

  global.IWSLocationController = {
    createLocationController,
  };
})(window);
