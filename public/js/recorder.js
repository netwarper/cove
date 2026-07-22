/* Meeting audio recorder.
 *
 * Captures your microphone ("you", getUserMedia) and the other side / what you
 * hear ("them", getDisplayMedia tab/system audio) and does two things:
 *
 *   1. Mixes BOTH sources into a single combined recording and, on stop, encodes
 *      it as one WAV file (audio/wav — a universally-playable format, unlike the
 *      webm MediaRecorder emits). Mono, 16 kHz: tuned for meeting speech and kept
 *      small.
 *   2. In parallel, taps each source separately (so the transcript can label who
 *      spoke) and emits short self-contained WAV chunks for near-live transcription.
 *
 * Nothing is uploaded unless a transcribe function is supplied; the recording
 * itself always stays local. Uses only the Web Audio API — no MediaRecorder, so
 * the output format is the same everywhere.
 */
(function () {
  'use strict';
  var CHUNK_MS = 6000;      // transcribe roughly every 6 seconds
  var TARGET_RATE = 16000;  // Whisper-friendly sample rate; also the saved-file rate

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext));
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

  function concatFloat32(parts) {
    var total = parts.reduce(function (a, b) { return a + b.length; }, 0);
    var merged = new Float32Array(total), off = 0;
    parts.forEach(function (b) { merged.set(b, off); off += b.length; });
    return merged;
  }

  /**
   * Start recording. opts:
   *   transcribeFn(wavBlob, source) -> Promise<string>   (optional; enables transcription)
   *   onLine({source,text,t})   onStatus(msg)   onError(err)
   * Returns a session with .stop() -> Promise<{ audio: Blob|null, themActive: bool }>.
   */
  async function start(opts) {
    opts = opts || {};
    var ctxClass = window.AudioContext || window.webkitAudioContext;
    var ctx = new ctxClass();
    if (ctx.state === 'suspended' && ctx.resume) { try { await ctx.resume(); } catch (_e) {} }
    var status = opts.onStatus || function () {};

    // Silent sink keeps the ScriptProcessors running without echoing to speakers.
    var sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);

    // Combined recording bus: every source feeds this, tapped once for the file.
    var mix = ctx.createGain(); mix.gain.value = 0.9; // slight headroom so two loud sources don't clip
    var recParts = [];
    var recProc = ctx.createScriptProcessor(4096, 1, 1);
    mix.connect(recProc); recProc.connect(sink);
    recProc.onaudioprocess = function (e) {
      recParts.push(downsample(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate, TARGET_RATE));
    };

    var sources = []; // { stream, src, tproc, timer }

    function addSource(stream, label) {
      var src = ctx.createMediaStreamSource(stream);
      src.connect(mix); // into the combined recording
      var entry = { stream: stream, src: src, tproc: null, timer: null };
      if (opts.transcribeFn) {
        // Separate per-source tap so each speaker's audio is transcribed & labeled.
        var tproc = ctx.createScriptProcessor(4096, 1, 1);
        src.connect(tproc); tproc.connect(sink);
        var pending = [];
        tproc.onaudioprocess = function (e) { pending.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
        entry.tproc = tproc;
        entry.timer = setInterval(function () {
          if (!pending.length) return;
          var merged = concatFloat32(pending); pending = [];
          // Timestamp when the chunk is CUT (when it was spoken), not when STT
          // returns — latency differs per request, which would scramble order.
          var cutAt = Date.now();
          var wav = encodeWav(downsample(merged, ctx.sampleRate, TARGET_RATE), TARGET_RATE);
          opts.transcribeFn(wav, label).then(function (text) {
            if (text && text.trim() && opts.onLine) opts.onLine({ source: label, text: text.trim(), t: cutAt });
          }).catch(function (err) { if (opts.onError) opts.onError(err); });
        }, CHUNK_MS);
      }
      sources.push(entry);
    }

    // Microphone ("you")
    var mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    addSource(mic, 'you');
    status('Recording your mic…');

    // System / other side ("them") — optional; user picks a tab/window with audio.
    var themActive = false;
    if (navigator.mediaDevices.getDisplayMedia) {
      try {
        var disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        if (disp.getAudioTracks().length) {
          disp.getVideoTracks().forEach(function (v) { v.stop(); }); // audio only
          addSource(disp, 'them');
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
      stop: function () {
        return new Promise(function (resolve) {
          sources.forEach(function (s) {
            if (s.timer) clearInterval(s.timer);
            try { if (s.tproc) s.tproc.disconnect(); s.src.disconnect(); } catch (_e) {}
            s.stream.getTracks().forEach(function (tr) { tr.stop(); });
          });
          try { recProc.disconnect(); mix.disconnect(); sink.disconnect(); } catch (_e) {}
          var samples = concatFloat32(recParts);
          var audio = samples.length ? encodeWav(samples, TARGET_RATE) : null;
          try { ctx.close(); } catch (_e) {}
          resolve({ audio: audio, themActive: themActive });
        });
      },
    };
  }

  // ---- Screen + audio recording (separate from the audio-only meeting recorder) ----

  function screenSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);
  }

  function pickVideoMime() {
    var cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (var i = 0; i < cands.length; i++) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(cands[i])) return cands[i];
    }
    return '';
  }

  /**
   * Record the screen (or a window/tab) with audio. Captures the shared video +
   * its system audio and mixes in your mic, recording to a single webm video.
   * Returns a session with .stop() -> Promise<Blob|null>.
   */
  async function startScreen(opts) {
    opts = opts || {};
    var status = opts.onStatus || function () {};
    var disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    var videoTrack = disp.getVideoTracks()[0];
    if (!videoTrack) { disp.getTracks().forEach(function (t) { t.stop(); }); throw new Error('no screen video was shared'); }

    var dispAudio = disp.getAudioTracks();
    var mic = null;
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (_e) { mic = null; }
    var micAudio = mic ? mic.getAudioTracks() : [];

    // Mix any system audio + mic into one track via Web Audio.
    var ctxClass = window.AudioContext || window.webkitAudioContext;
    var ctx = null, mixedAudioTrack = null;
    if ((dispAudio.length || micAudio.length) && ctxClass) {
      ctx = new ctxClass();
      var dest = ctx.createMediaStreamDestination();
      if (dispAudio.length) ctx.createMediaStreamSource(new MediaStream([dispAudio[0]])).connect(dest);
      if (micAudio.length) ctx.createMediaStreamSource(new MediaStream([micAudio[0]])).connect(dest);
      mixedAudioTrack = dest.stream.getAudioTracks()[0];
    }

    var tracks = [videoTrack];
    if (mixedAudioTrack) tracks.push(mixedAudioTrack);
    var mime = pickVideoMime();
    var rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.start();
    status(dispAudio.length ? 'Recording screen + shared audio' + (micAudio.length ? ' + mic…' : '…')
      : (micAudio.length ? 'Recording screen + mic…' : 'Recording screen (no audio shared)…'));

    // Ending the share from the browser's own "Stop sharing" bar ends the recording.
    videoTrack.addEventListener('ended', function () { if (opts.onAutoStop) opts.onAutoStop(); });

    function stopAll() {
      [videoTrack].concat(Array.prototype.slice.call(dispAudio), Array.prototype.slice.call(micAudio)).forEach(function (t) { try { t.stop(); } catch (_e) {} });
      try { if (ctx) ctx.close(); } catch (_e) {}
    }

    return {
      hasAudio: !!mixedAudioTrack,
      stop: function () {
        return new Promise(function (resolve) {
          if (rec.state !== 'inactive') {
            rec.onstop = function () { stopAll(); resolve(chunks.length ? new Blob(chunks, { type: chunks[0].type || rec.mimeType || 'video/webm' }) : null); };
            rec.stop();
          } else { stopAll(); resolve(chunks.length ? new Blob(chunks, { type: 'video/webm' }) : null); }
        });
      },
    };
  }

  window.Recorder = { supported: supported, start: start, screenSupported: screenSupported, startScreen: startScreen };
})();
