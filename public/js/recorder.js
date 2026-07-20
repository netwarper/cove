/* Meeting audio recorder.
 *
 * Captures TWO sources and keeps them separate so the transcript can label who
 * spoke:
 *   - "you"  = your microphone (getUserMedia)
 *   - "them" = the other side / what you hear (getDisplayMedia tab/system audio)
 *
 * Each source is saved via MediaRecorder (encrypted attachment on stop) and,
 * in parallel, tapped through the Web Audio API to emit independent WAV chunks
 * every few seconds for near-live transcription. WAV chunks are self-contained
 * (unlike mid-stream webm), so each can be transcribed on its own.
 *
 * Nothing is uploaded unless a transcribe function is supplied; the recording
 * itself always stays local.
 */
(function () {
  'use strict';
  var CHUNK_MS = 6000;      // transcribe roughly every 6 seconds
  var TARGET_RATE = 16000;  // Whisper-friendly sample rate

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && (window.AudioContext || window.webkitAudioContext));
  }

  function encodeWav(samples, rate) {
    var buf = new ArrayBuffer(44 + samples.length * 2);
    var v = new DataView(buf);
    function str(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    var off = 44;
    for (var i = 0; i < samples.length; i++) { var s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2; }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function downsample(buffer, inRate, outRate) {
    if (outRate >= inRate) return buffer;
    var ratio = inRate / outRate, outLen = Math.round(buffer.length / ratio), out = new Float32Array(outLen);
    var oi = 0, ii = 0;
    while (oi < outLen) {
      var next = Math.round((oi + 1) * ratio), sum = 0, cnt = 0;
      for (; ii < next && ii < buffer.length; ii++) { sum += buffer[ii]; cnt++; }
      out[oi] = cnt ? sum / cnt : 0; oi++;
    }
    return out;
  }

  // One capture source: MediaRecorder (save) + ScriptProcessor tap (transcribe chunks).
  function makeSource(stream, label, ctxClass, transcribeFn, onLine, onError) {
    var rec = null, recChunks = [];
    try {
      var mime = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = function (e) { if (e.data && e.data.size) recChunks.push(e.data); };
      rec.start();
    } catch (e) { /* saving unavailable; transcription can still work */ }

    var ctx = new ctxClass();
    var src = ctx.createMediaStreamSource(stream);
    var proc = ctx.createScriptProcessor(4096, 1, 1);
    var sink = ctx.createGain(); sink.gain.value = 0; // silence — no echo/playback
    src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    var pending = [];
    proc.onaudioprocess = function (e) { pending.push(new Float32Array(e.inputBuffer.getChannelData(0))); };

    var timer = null;
    if (transcribeFn) {
      timer = setInterval(function () {
        if (!pending.length) return;
        var total = pending.reduce(function (a, b) { return a + b.length; }, 0);
        var merged = new Float32Array(total), off = 0;
        pending.forEach(function (b) { merged.set(b, off); off += b.length; });
        pending = [];
        var wav = encodeWav(downsample(merged, ctx.sampleRate, TARGET_RATE), TARGET_RATE);
        transcribeFn(wav, label).then(function (text) {
          if (text && text.trim()) onLine({ source: label, text: text.trim(), t: Date.now() });
        }).catch(function (err) { if (onError) onError(err); });
      }, CHUNK_MS);
    }

    return {
      label: label,
      stop: function () {
        return new Promise(function (resolve) {
          if (timer) clearInterval(timer);
          try { proc.disconnect(); src.disconnect(); sink.disconnect(); } catch (e) {}
          try { ctx.close(); } catch (e) {}
          stream.getTracks().forEach(function (tr) { tr.stop(); });
          if (rec && rec.state !== 'inactive') {
            rec.onstop = function () { resolve(recChunks.length ? new Blob(recChunks, { type: recChunks[0].type || 'audio/webm' }) : null); };
            rec.stop();
          } else resolve(recChunks.length ? new Blob(recChunks) : null);
        });
      },
    };
  }

  /**
   * Start recording. opts:
   *   transcribeFn(wavBlob, source) -> Promise<string>   (optional; enables transcription)
   *   onLine({source,text,t})   onStatus(msg)   onError(err)
   * Returns a session with .stop() -> Promise<{ you: Blob|null, them: Blob|null }>.
   */
  async function start(opts) {
    opts = opts || {};
    var ctxClass = window.AudioContext || window.webkitAudioContext;
    var sources = [];
    var status = opts.onStatus || function () {};

    // Microphone ("you")
    var mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    sources.push(makeSource(mic, 'you', ctxClass, opts.transcribeFn, opts.onLine, opts.onError));
    status('Recording your mic…');

    // System / other side ("them") — optional; needs a user pick of a tab/screen with audio.
    var themActive = false;
    if (navigator.mediaDevices.getDisplayMedia) {
      try {
        var disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        if (disp.getAudioTracks().length) {
          disp.getVideoTracks().forEach(function (v) { v.stop(); }); // we only want the audio
          sources.push(makeSource(disp, 'them', ctxClass, opts.transcribeFn, opts.onLine, opts.onError));
          themActive = true;
          status('Recording your mic + shared audio…');
        } else {
          disp.getTracks().forEach(function (tr) { tr.stop(); });
          status('Recording your mic (no shared audio was included — pick a tab/window and enable "Share audio" to capture the other side).');
        }
      } catch (e) { status('Recording your mic (screen/tab audio not shared).'); }
    }

    return {
      themActive: themActive,
      stop: async function () {
        var out = { you: null, them: null };
        for (var i = 0; i < sources.length; i++) { var b = await sources[i].stop(); out[sources[i].label] = b; }
        return out;
      },
    };
  }

  window.Recorder = { supported: supported, start: start };
})();
