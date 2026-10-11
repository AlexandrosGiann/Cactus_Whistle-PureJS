/* Page logic for the Whistle pure-JavaScript demo: model loading, audio input, UI. */
(function () {
'use strict';

var MODEL_URL = 'whistle.cact';
var SAMPLE_URL = 'whistle_recording_16k.wav';
var RATE = 16000;
var MAX_RECORD_SECONDS = 120;
var LANGUAGE_NAMES = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pl: 'Polish' };

function $(id) { return document.getElementById(id); }

var el = {
  modelStatus: $('modelStatus'), modelBar: $('modelBar'), modelPick: $('modelPick'), modelFile: $('modelFile'),
  record: $('recordButton'), recordLabel: $('recordLabel'), file: $('audioFile'), sample: $('sampleButton'),
  language: $('language'), mode: $('mode'), clip: $('clip'), player: $('player'), clipInfo: $('clipInfo'),
  runBar: $('runBar'), runStatus: $('runStatus'), transcript: $('transcript'), details: $('details'),
  copy: $('copyButton'), meter: $('meter')
};

var engine = null;          // { transcribe(pcm, opts, handlers) }
var busy = false, ready = false, jobId = 0, handlers = {};

// ------------------------------------------------------------------ engine

function setReady(info) {
  ready = true;
  el.modelBar.style.width = '100%';
  el.modelBar.parentNode.classList.add('done');
  el.modelPick.hidden = true;
  el.modelStatus.textContent = 'Model ready: ' + (info.bytes / 1e6).toFixed(1) + ' MB, ' +
    info.tensors + ' tensors, parsed in ' + Math.round(info.ms) + ' ms' + (info.inline ? ' (main thread)' : '');
  updateButtons();
}

function workerEngine(buffer) {
  return new Promise(function (resolve, reject) {
    var w;
    try { w = new Worker('whistle_worker.js'); } catch (e) { reject(e); return; }
    var started = false;
    w.onerror = function (e) {
      if (!started) reject(new Error(e.message || 'worker failed to start'));
      else fail('Worker error: ' + (e.message || 'unknown'));
    };
    w.onmessage = function (ev) {
      var m = ev.data;
      if (m.type === 'loaded') {
        started = true;
        resolve({
          info: m,
          transcribe: function (pcm, opts, h) {
            var id = ++jobId;
            handlers[id] = h;
            w.postMessage({ type: 'transcribe', id: id, pcm: pcm, language: opts.language, beams: opts.beams });
          }
        });
        return;
      }
      if (m.type === 'error' && !started) { reject(new Error(m.message)); return; }
      var h = handlers[m.id];
      if (!h) return;
      if (m.type === 'progress') h.progress(m.stage, m.fraction, m.overall);
      else if (m.type === 'partial') h.partial(m.text);
      else if (m.type === 'window') h.window(m.text, m.done);
      else if (m.type === 'result') { delete handlers[m.id]; h.done(m); }
      else if (m.type === 'error') { delete handlers[m.id]; h.error(m.message); }
    };
    w.postMessage({ type: 'load', buffer: buffer });
  });
}

// Fallback when workers are unavailable (for example a page opened from file://).
function inlineEngine(buffer) {
  var t0 = performance.now(), model = new Whistle.Model(buffer);
  return {
    info: { ms: performance.now() - t0, tensors: model.cact.numTensors, bytes: buffer.byteLength, inline: true },
    transcribe: function (pcm, opts, h) {
      setTimeout(function () {
        try {
          var r = model.transcribe(pcm, { language: opts.language, beams: opts.beams });
          h.done({ text: r.text, language: r.language, silent: r.silent, tokens: r.tokens.length,
            timings: r.timings, seconds: pcm.length / RATE });
        } catch (e) { h.error(String(e.message || e)); }
      }, 30);
    }
  };
}

function installModel(buffer) {
  el.modelStatus.textContent = 'Parsing model...';
  return workerEngine(buffer).catch(function (err) {
    if (typeof Whistle === 'undefined') throw err;
    return inlineEngine(buffer);
  }).then(function (e) {
    engine = e;
    setReady(e.info);
  }).catch(function (err) {
    el.modelStatus.textContent = 'Could not load the model: ' + (err.message || err);
    el.modelPick.hidden = false;
  });
}

function fetchModel() {
  el.modelStatus.textContent = 'Downloading ' + MODEL_URL + '...';
  if (typeof fetch !== 'function') return Promise.reject(new Error('fetch is not available'));
  return fetch(MODEL_URL).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var total = +res.headers.get('Content-Length') || 0;
    if (!res.body || !res.body.getReader) return res.arrayBuffer();
    var reader = res.body.getReader(), chunks = [], got = 0;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          var out = new Uint8Array(got), o = 0;
          for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
          return out.buffer;
        }
        chunks.push(r.value); got += r.value.length;
        if (total) el.modelBar.style.width = Math.round(100 * got / total) + '%';
        el.modelStatus.textContent = 'Downloading model: ' + (got / 1e6).toFixed(1) +
          (total ? ' / ' + (total / 1e6).toFixed(1) : '') + ' MB';
        return pump();
      });
    }
    return pump();
  });
}

// ------------------------------------------------------------------- audio

function parsePcm16Wav(ab) {
  var dv = new DataView(ab);
  function tag(o) { return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)); }
  if (ab.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  var p = 12, fmt = null;
  while (p + 8 <= ab.byteLength) {
    var id = tag(p), len = dv.getUint32(p + 4, true), body = p + 8;
    if (id === 'fmt ') {
      fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || fmt.rate !== RATE) return null;
      var frames = Math.floor(Math.min(len, ab.byteLength - body) / (2 * fmt.channels));
      var out = new Float32Array(frames);
      for (var i = 0; i < frames; i++) {
        var s = 0;
        for (var c = 0; c < fmt.channels; c++) s += dv.getInt16(body + (i * fmt.channels + c) * 2, true);
        out[i] = s / (32768 * fmt.channels);
      }
      return out;
    }
    p = body + len + (len & 1);
  }
  return null;
}

function mixDown(buffer) {
  var n = buffer.length, out = new Float32Array(n), ch = buffer.numberOfChannels;
  for (var c = 0; c < ch; c++) {
    var d = buffer.getChannelData(c);
    for (var i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

function resample(samples, fromRate) {
  if (fromRate === RATE) return Promise.resolve(samples);
  var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  var frames = Math.max(1, Math.round(samples.length * RATE / fromRate));
  if (!Offline) return Promise.resolve(linearResample(samples, fromRate, frames));
  try {
    var ctx = new Offline(1, frames, RATE), buf = ctx.createBuffer(1, samples.length, fromRate);
    buf.getChannelData(0).set(samples);
    var src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start(0);
    return ctx.startRendering().then(function (r) { return new Float32Array(r.getChannelData(0)); });
  } catch (e) {
    return Promise.resolve(linearResample(samples, fromRate, frames));
  }
}

function linearResample(input, fromRate, frames) {
  var out = new Float32Array(frames), ratio = fromRate / RATE;
  for (var i = 0; i < frames; i++) {
    var x = i * ratio, i0 = Math.floor(x), i1 = Math.min(i0 + 1, input.length - 1), a = x - i0;
    out[i] = input[i0] * (1 - a) + input[i1] * a;
  }
  return out;
}

// Any file the browser can decode becomes 16 kHz mono float samples.
function decodeFile(ab) {
  var direct = parsePcm16Wav(ab);
  if (direct) return Promise.resolve(direct);
  var Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return Promise.reject(new Error('this browser cannot decode audio; use a 16 kHz PCM WAV'));
  var ctx = new Ctx();
  return new Promise(function (resolve, reject) {
    ctx.decodeAudioData(ab.slice(0), resolve, function () { reject(new Error('unsupported audio file')); });
  }).then(function (buffer) {
    if (ctx.close) ctx.close();
    return resample(mixDown(buffer), buffer.sampleRate);
  });
}

function wavBlob(samples) {
  var n = samples.length, ab = new ArrayBuffer(44 + n * 2), dv = new DataView(ab);
  function ascii(o, t) { for (var i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); }
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); ascii(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); ascii(36, 'data'); dv.setUint32(40, n * 2, true);
  for (var i = 0; i < n; i++) {
    var x = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.round(x * 32767), true);
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// --------------------------------------------------------------- recording

var rec = null;

function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    fail('The microphone is not available here. It needs https:// or http://localhost.');
    return;
  }
  setRun('Waiting for microphone permission...', 0);
  navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  }).then(function (stream) {
    var Ctx = window.AudioContext || window.webkitAudioContext, ctx = new Ctx();
    var source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but works on every engine that has Web Audio.
    var proc = ctx.createScriptProcessor(4096, 1, 1), mute = ctx.createGain();
    mute.gain.value = 0;
    rec = { ctx: ctx, stream: stream, source: source, proc: proc, mute: mute, chunks: [], samples: 0, started: performance.now() };
    proc.onaudioprocess = function (ev) {
      if (!rec) return;
      var d = ev.inputBuffer.getChannelData(0), peak = 0;
      rec.chunks.push(new Float32Array(d));
      rec.samples += d.length;
      for (var i = 0; i < d.length; i += 16) { var a = Math.abs(d[i]); if (a > peak) peak = a; }
      el.meter.style.width = Math.min(100, Math.round(peak * 140)) + '%';
      var secs = rec.samples / ctx.sampleRate;
      el.recordLabel.textContent = 'Stop (' + secs.toFixed(1) + ' s)';
      if (secs >= MAX_RECORD_SECONDS) stopRecording();
    };
    source.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    el.record.classList.add('recording');
    el.recordLabel.textContent = 'Stop';
    setRun('Recording... speak, then press Stop.', 0);
    updateButtons();
  }).catch(function (e) {
    fail('Microphone error: ' + (e.message || e.name || e));
  });
}

function stopRecording() {
  if (!rec) return;
  var r = rec;
  rec = null;
  try { r.proc.disconnect(); r.source.disconnect(); r.mute.disconnect(); } catch (e) {}
  var tracks = r.stream.getTracks();
  for (var i = 0; i < tracks.length; i++) tracks[i].stop();
  var rate = r.ctx.sampleRate;
  try { r.ctx.close(); } catch (e) {}
  el.record.classList.remove('recording');
  el.recordLabel.textContent = 'Record';
  el.meter.style.width = '0%';
  var all = new Float32Array(r.samples), o = 0;
  for (i = 0; i < r.chunks.length; i++) { all.set(r.chunks[i], o); o += r.chunks[i].length; }
  if (all.length < rate / 10) { fail('The recording is too short.'); updateButtons(); return; }
  resample(all, rate).then(function (pcm) { run(pcm, 'Recording'); });
}

// ---------------------------------------------------------------------- UI

function updateButtons() {
  var idle = ready && !busy;
  el.record.disabled = !(idle || rec);
  el.file.disabled = !idle || !!rec;
  el.sample.disabled = !idle || !!rec;
  el.file.parentNode.classList.toggle('disabled', el.file.disabled);
}

function setRun(text, fraction) {
  el.runStatus.textContent = text;
  el.runBar.style.width = Math.round(100 * Math.max(0, Math.min(1, fraction))) + '%';
}

function fail(message) {
  busy = false;
  setRun(message, 0);
  el.runStatus.classList.add('error');
  updateButtons();
}

function showClip(pcm, label) {
  if (el.player.src) URL.revokeObjectURL(el.player.src);
  el.player.src = URL.createObjectURL(wavBlob(pcm));
  el.clipInfo.textContent = label + ' · ' + (pcm.length / RATE).toFixed(2) + ' s';
  el.clip.hidden = false;
}

function run(pcm, label) {
  if (!ready || busy) return;
  busy = true;
  el.runStatus.classList.remove('error');
  updateButtons();
  showClip(pcm, label);
  el.transcript.textContent = '';
  el.transcript.classList.add('pending');
  el.details.textContent = '';
  el.copy.hidden = true;
  setRun('Reading audio...', 0.02);
  var seconds = pcm.length / RATE, beams = el.mode.value === 'fast' ? 1 : 5, prefix = '';
  var windows = Math.max(1, Math.ceil(seconds / 30));
  engine.transcribe(pcm, { language: el.language.value || null, beams: beams }, {
    progress: function (stage, fraction, overall) {
      var f = windows > 1 && overall !== undefined ? overall
        : stage === 'encoder' ? 0.05 + 0.45 * fraction : stage === 'decoder' ? 0.5 : 0.03;
      setRun(stage === 'encoder' ? 'Listening (encoder)...' : stage === 'decoder' ? 'Writing (decoder)...' : 'Reading audio...', f);
    },
    partial: function (text) {
      el.transcript.textContent = (prefix ? prefix + ' ' : '') + text;
      if (windows === 1) setRun('Writing (decoder)...', Math.min(0.97, 0.5 + 0.02 * text.length / 4));
    },
    window: function (text) { prefix = text; el.transcript.textContent = text; },
    done: function (r) {
      busy = false;
      el.transcript.classList.remove('pending');
      el.transcript.textContent = r.silent ? '(no speech detected)' : r.text;
      el.transcript.classList.toggle('empty', !!r.silent);
      el.copy.hidden = !r.text;
      var t = r.timings, parts = [];
      if (r.language) parts.push('Language: ' + (LANGUAGE_NAMES[r.language] || r.language));
      parts.push('Audio: ' + r.seconds.toFixed(2) + ' s');
      parts.push('Time: ' + (t.total / 1000).toFixed(2) + ' s (' + (t.total / 1000 / r.seconds).toFixed(2) + '× real time)');
      if (t.encoder) parts.push('encoder ' + Math.round(t.encoder) + ' ms, decoder ' + Math.round(t.decoder) + ' ms');
      el.details.textContent = parts.join(' · ');
      setRun('Done.', 1);
      updateButtons();
    },
    error: function (message) { el.transcript.classList.remove('pending'); fail('Error: ' + message); }
  });
}

function loadUrl(url, label) {
  setRun('Loading ' + label + '...', 0.01);
  fetch(url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(decodeFile).then(function (pcm) { run(pcm, label); }).catch(function (e) {
    fail('Could not load ' + label + ': ' + (e.message || e));
  });
}

el.record.onclick = function () { if (rec) stopRecording(); else startRecording(); };
el.sample.onclick = function () { loadUrl(SAMPLE_URL, 'Sample clip'); };
el.file.onchange = function () {
  var f = el.file.files[0];
  if (!f) return;
  setRun('Decoding ' + f.name + '...', 0.01);
  f.arrayBuffer().then(decodeFile).then(function (pcm) { run(pcm, f.name); }).catch(function (e) {
    fail('Could not read ' + f.name + ': ' + (e.message || e));
  });
  el.file.value = '';
};
el.modelFile.onchange = function () {
  var f = el.modelFile.files[0];
  if (f) f.arrayBuffer().then(installModel);
};
el.copy.onclick = function () {
  var text = el.transcript.textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
  el.copy.textContent = 'Copied';
  setTimeout(function () { el.copy.textContent = 'Copy'; }, 1200);
};

updateButtons();
fetchModel().then(installModel).catch(function (e) {
  el.modelStatus.textContent = 'Automatic model download failed (' + (e.message || e) +
    '). Choose whistle.cact from your disk:';
  el.modelPick.hidden = false;
});
})();
