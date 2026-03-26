'use strict';

(function registerInteractionController(global) {
  function createInteractionController(opts) {
    const {
      els,
      state,
      testMode,
      clamp,
      debounce,
      renderSoon,
      nextPaint,
      redrawChartOnly,
      fetchDay,
      refreshTimeSensitiveUi,
    } = opts;

    let attached = false;
    let chartHover = { active: false, idx: -1 };
    let chartGeom = null;
    let chartResizeObserver = null;
    let uiTick = null;

    function getChartHover() {
      return chartHover;
    }

    function getChartGeom() {
      return chartGeom;
    }

    function setChartGeom(geom) {
      chartGeom = geom || null;
    }

    function clearChartHover() {
      if (!chartHover.active && chartHover.idx < 0) return;
      chartHover = { active: false, idx: -1 };
      redrawChartOnly();
    }

    function reset() {
      chartHover = { active: false, idx: -1 };
      chartGeom = null;
    }

    function setSelectorTestChartHover({
      active = false,
      idx = -1,
      geom = undefined,
    } = {}) {
      chartHover = {
        active: Boolean(active),
        idx: Boolean(active) ? Number(idx) : -1,
      };
      if (geom !== undefined) chartGeom = geom;
    }

    function chartHoverIndexFromClientX(clientX) {
      if (!els.canvas || !chartGeom || chartGeom.ptsLen < 1) return -1;
      const rect = els.canvas.getBoundingClientRect();
      const localX = clientX - rect.left;
      const minX = chartGeom.padX;
      const maxX = chartGeom.w - chartGeom.padX;
      const clampedX = clamp(localX, minX, maxX);
      const span = Math.max(1, maxX - minX);
      const u = (clampedX - minX) / span;
      return clamp(Math.round(u * (chartGeom.ptsLen - 1)), 0, chartGeom.ptsLen - 1);
    }

    function updateChartHoverFromClientX(clientX) {
      const idx = chartHoverIndexFromClientX(clientX);
      if (idx < 0) return;
      if (chartHover.active && chartHover.idx === idx) return;
      chartHover = { active: true, idx };
      redrawChartOnly();
    }

    function attachCanvasHover() {
      if (!els.canvas) return;

      let touchPointerId = null;

      els.canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        if (!state.data || state.isBusy) return;
        touchPointerId = e.pointerId;
        try {
          els.canvas.setPointerCapture(e.pointerId);
        } catch {}
        updateChartHoverFromClientX(e.clientX);
      });

      els.canvas.addEventListener('pointermove', (e) => {
        if (!state.data || state.isBusy) return;

        if (e.pointerType === 'touch') {
          if (touchPointerId == null || e.pointerId !== touchPointerId) return;
          updateChartHoverFromClientX(e.clientX);
          return;
        }

        updateChartHoverFromClientX(e.clientX);
      });

      els.canvas.addEventListener('pointerup', (e) => {
        if (e.pointerType !== 'touch') return;
        if (touchPointerId != null && e.pointerId === touchPointerId) {
          touchPointerId = null;
          clearChartHover();
          try {
            els.canvas.releasePointerCapture(e.pointerId);
          } catch {}
        }
      });

      els.canvas.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'touch') return;
        clearChartHover();
      });

      els.canvas.addEventListener('pointercancel', (e) => {
        if (e.pointerType === 'touch' && touchPointerId != null && e.pointerId === touchPointerId) {
          touchPointerId = null;
          clearChartHover();
          try {
            els.canvas.releasePointerCapture(e.pointerId);
          } catch {}
          return;
        }
        if (e.pointerType !== 'touch') clearChartHover();
      });
    }

    function initMobilePullToRefresh() {
      const mqMobile = global.matchMedia ? global.matchMedia('(max-width: 700px)') : null;
      const mqCoarse = global.matchMedia ? global.matchMedia('(pointer: coarse)') : null;
      const hasTouch = () => (navigator.maxTouchPoints || 0) > 0;
      const isActiveContext = () => Boolean(
        mqMobile && mqMobile.matches && ((mqCoarse && mqCoarse.matches) || hasTouch())
      );
      if (!isActiveContext()) return;

      const indicator = document.createElement('div');
      indicator.className = 'ptrIndicator';
      indicator.textContent = 'Pull to refresh';
      document.body.appendChild(indicator);

      const THRESHOLD_PX = 72;
      const MAX_PULL_PX = 120;
      let activeTouchId = null;
      let startY = 0;
      let isPulling = false;
      let isArmed = false;
      let settleTimer = null;

      const setPullPx = (px) => {
        if (!document.body) return;
        document.body.style.setProperty('--ptr-pull', `${Math.round(Math.max(0, Number(px) || 0))}px`);
      };

      const beginSettling = () => {
        if (!document.body) return;
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        document.body.classList.remove('ptrPulling');
        document.body.classList.add('ptrSettling');
        setPullPx(0);
        settleTimer = global.setTimeout(() => {
          if (!document.body) return;
          document.body.classList.remove('ptrSettling');
          settleTimer = null;
        }, 200);
      };

      const hideIndicator = (settle = true) => {
        indicator.classList.remove('active', 'armed', 'loading');
        if (settle) beginSettling();
      };

      const canStart = (event) => {
        if (!isActiveContext()) return false;
        if (state.isBusy) return false;
        if ((global.scrollY || global.pageYOffset || 0) > 0) return false;
        if (event.target && event.target.closest && event.target.closest('#sunChart')) return false;
        return true;
      };

      const findTouchById = (touchList, id) => {
        for (let i = 0; i < touchList.length; i += 1) {
          const touch = touchList[i];
          if (touch.identifier === id) return touch;
        }
        return null;
      };

      global.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        if (!canStart(e)) return;
        const touch = e.touches[0];
        activeTouchId = touch.identifier;
        startY = touch.clientY;
        isPulling = true;
        isArmed = false;
        indicator.textContent = 'Pull to refresh';
        if (document.body) {
          document.body.classList.remove('ptrSettling');
          document.body.classList.remove('ptrPulling');
        }
        setPullPx(0);
        hideIndicator(false);
      }, { passive: true });

      global.addEventListener('touchmove', (e) => {
        if (!isPulling || activeTouchId == null) return;
        const touch = findTouchById(e.touches, activeTouchId);
        if (!touch) return;

        const pull = clamp(touch.clientY - startY, 0, MAX_PULL_PX);
        if (pull <= 0) {
          hideIndicator(false);
          return;
        }

        if (e.cancelable) e.preventDefault();
        if (document.body) {
          document.body.classList.remove('ptrSettling');
          document.body.classList.add('ptrPulling');
        }
        setPullPx(pull);
        indicator.classList.add('active');
        isArmed = pull >= THRESHOLD_PX;
        indicator.classList.toggle('armed', isArmed);
        indicator.textContent = isArmed ? 'Release to refresh' : 'Pull to refresh';
      }, { passive: false });

      const endPull = (touchList) => {
        if (!isPulling || activeTouchId == null) return;
        if (findTouchById(touchList, activeTouchId)) return;

        const shouldRefresh = isArmed && !state.isBusy;
        isPulling = false;
        isArmed = false;
        activeTouchId = null;

        if (!shouldRefresh) {
          hideIndicator(true);
          return;
        }

        beginSettling();
        indicator.classList.remove('armed');
        indicator.classList.add('active', 'loading');
        indicator.textContent = 'Refreshing…';
        Promise.resolve(fetchDay(true)).finally(() => {
          global.setTimeout(() => hideIndicator(), 260);
        });
      };

      global.addEventListener('touchend', (e) => {
        endPull(e.touches);
      }, { passive: true });

      global.addEventListener('touchcancel', (e) => {
        endPull(e.touches);
      }, { passive: true });
    }

    function startUiTick() {
      if (uiTick) return;
      refreshTimeSensitiveUi(true);
      uiTick = setInterval(() => refreshTimeSensitiveUi(false), 15 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshTimeSensitiveUi(true);
      });
      global.addEventListener('focus', () => refreshTimeSensitiveUi(true));
    }

    function attach() {
      if (attached) return;
      attached = true;

      if (els.btnRefresh) {
        els.btnRefresh.addEventListener('click', () => fetchDay(true));
      }

      if (els.daySelect) {
        els.daySelect.addEventListener('change', async () => {
          if (!state.data) return;
          clearChartHover();
          await nextPaint();
          renderSoon();
        });
      }

      const onResize = debounce(() => {
        if (!state.data || state.isBusy) return;
        renderSoon();
      }, 160);

      global.addEventListener('resize', onResize);
      global.addEventListener('orientationchange', onResize);

      if (global.visualViewport) {
        global.visualViewport.addEventListener('resize', onResize);
      }

      try {
        if (global.ResizeObserver && els.canvas) {
          chartResizeObserver = new ResizeObserver(() => {
            if (!state.data || state.isBusy) return;
            renderSoon();
          });
          chartResizeObserver.observe(els.canvas);
        }
      } catch {
        // Ignore ResizeObserver setup failures.
      }

      attachCanvasHover();

      if (!testMode) initMobilePullToRefresh();
      if (!testMode) startUiTick();
    }

    return {
      attach,
      clearChartHover,
      getChartGeom,
      getChartHover,
      reset,
      setChartGeom,
      setSelectorTestChartHover,
    };
  }

  global.IWSInteractionController = {
    createInteractionController,
  };
})(window);
