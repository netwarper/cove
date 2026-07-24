/* On-device OCR (Tesseract.js), fully offline. Makes pasted screenshots
 * searchable by extracting their text. All assets are vendored under
 * /vendor/tesseract — nothing is fetched from the network. Loaded lazily so it
 * costs nothing until the first image is processed. */
(function () {
  'use strict';

  var BASE = '/vendor/tesseract/';
  var libPromise = null;   // resolves when window.Tesseract is loaded
  var workerPromise = null; // resolves to a ready recognizer worker
  var unavailable = false;  // set true if assets/engine can't load

  // Present only if the vendored library file exists (feature-detect).
  function loadLib() {
    if (libPromise) return libPromise;
    libPromise = new Promise(function (resolve, reject) {
      if (window.Tesseract) return resolve(window.Tesseract);
      var s = document.createElement('script');
      s.src = BASE + 'tesseract.min.js';
      s.onload = function () { window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract missing')); };
      s.onerror = function () { reject(new Error('tesseract.min.js failed to load')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  function getWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = loadLib().then(function (T) {
      // All paths are local; corePath is pinned to the SIMD LSTM core we ship.
      return T.createWorker('eng', 1 /* OEM: LSTM_ONLY */, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE + 'tesseract-core-simd-lstm.wasm.js',
        langPath: BASE + 'lang',
        gzip: true,
        legacyCore: false,
        legacyLang: false,
      });
    });
    return workerPromise;
  }

  var OCR = {
    // Best-effort: does the vendored library file exist in this build?
    available: function () {
      if (unavailable) return Promise.resolve(false);
      return fetch(BASE + 'tesseract.min.js', { method: 'HEAD' })
        .then(function (r) { return r.ok; })
        .catch(function () { return false; });
    },
    // Recognize text in an image (File/Blob/dataURL). Returns '' on failure.
    recognize: function (image) {
      return getWorker()
        .then(function (w) { return w.recognize(image); })
        .then(function (res) { return (res && res.data && res.data.text || '').trim(); })
        .catch(function (e) { unavailable = true; try { console.warn('OCR failed:', e && e.message); } catch (_e) {} return ''; });
    },
    // Free the worker (and its ~10 MB of buffers) when idle.
    terminate: function () {
      if (!workerPromise) return;
      var p = workerPromise; workerPromise = null;
      p.then(function (w) { try { w.terminate(); } catch (_e) {} }).catch(function () {});
    },
  };

  window.OCR = OCR;
})();
