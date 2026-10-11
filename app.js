/* Page logic for the Whistle pure-JavaScript demo: model loading, audio input, UI. */
(function () {
'use strict';

var MODEL_URL = 'whistle.cact';
// tried in order: a checkout without the first clip still has the second
var SAMPLE_URLS = ['whistle_recording_16k.wav', 'test/audio/jfk.wav'];
var RATE = 16000;
var MAX_RECORD_SECONDS = 120;
var LANGUAGE_NAMES = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pl: 'Polish' };

function $(id) { return document.getElementById(id); }

var el = {
  modelStatus: $('modelStatus'), modelBar: $('modelBar'), modelPick: $('modelPick'), modelFile: $('modelFile'),
  record: $('recordButton'), recordLabel: $('recordLabel'), file: $('audioFile'), sample: $('sampleButton'),
  language: $('language'), mode: $('mode'), clip: $('clip'), player: $('player'), clipInfo: $('clipInfo'),
  runBar: $('runBar'), runStatus: $('runStatus'), transcript: $('transcript'), details: $('details'),
  copy: $('copyButton'), meter: $('meter'), diagLog: $('diagLog'), diagCopy: $('diagCopy'), micTest: $('micTest'), micSetup: $('micSetup')
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

var AMR_URL = 'vendor/amrnb.js';
var amrLoading = null;

function startsWith(ab, text) {
  if (ab.byteLength < text.length) return false;
  var u = new Uint8Array(ab, 0, text.length);
  for (var i = 0; i < text.length; i++) if (u[i] !== text.charCodeAt(i)) return false;
  return true;
}

// The AMR decoder (opencore-amr compiled to plain asm.js, about 0.5 MB) is fetched on first use.
function loadAmr() {
  if (window.AMR) return Promise.resolve(window.AMR);
  if (!amrLoading) {
    amrLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = AMR_URL;
      s.onload = function () { if (window.AMR) resolve(window.AMR); else reject(new Error('the AMR decoder did not start')); };
      s.onerror = function () { amrLoading = null; reject(new Error(AMR_URL + ' could not be loaded')); };
      document.head.appendChild(s);
    });
  }
  return amrLoading;
}

// AMR-NB, the format of phone voice recorders: 8 kHz speech frames after a "#!AMR" line.
function decodeAmr(ab) {
  return loadAmr().then(function (AMR) {
    var pcm = AMR.decode(new Uint8Array(ab));
    if (!pcm || !pcm.length) throw new Error('the AMR file holds no decodable audio');
    return resample(new Float32Array(pcm), 8000);
  });
}

// Any file the browser can decode becomes 16 kHz mono float samples.
function decodeFile(ab) {
  if (startsWith(ab, '#!AMR-WB\n')) return Promise.reject(new Error('AMR-WB is not supported, only AMR-NB (.amr)'));
  if (startsWith(ab, '#!AMR\n')) return decodeAmr(ab);
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

var diagLines = [];

// Shown in the "Microphone diagnostics" panel: a phone has no developer console to read.
function diag(text) {
  var t = (performance.now() / 1000).toFixed(2);
  diagLines.push('[' + t + '] ' + text);
  if (diagLines.length > 300) diagLines.shift();
  if (el.diagLog) el.diagLog.textContent = diagLines.join('\n');
  if (window.console && console.log) console.log('[mic] ' + text);
}

function decodeBlob(blob) {
  return readFile(blob).then(function (ab) {
    diag('decoding ' + ab.byteLength + ' bytes of ' + (blob.type || 'unknown type'));
    return decodeFile(ab);
  });
}

var recorder = new WhistleRecorder.Recorder({
  navigator: navigator, AudioContext: window.AudioContext || window.webkitAudioContext,
  MediaRecorder: window.MediaRecorder, Blob: window.Blob, isSecureContext: window.isSecureContext,
  now: function () { return performance.now(); }, log: diag, decodeBlob: decodeBlob,
  maxSeconds: MAX_RECORD_SECONDS,
  onLevel: function (peak, seconds) {
    el.meter.style.width = Math.min(100, Math.round(peak * 140)) + '%';
    el.recordLabel.textContent = 'Stop (' + seconds.toFixed(1) + ' s)';
  },
  onEnded: function () { stopRecording(); }
});

// The capture setup found by the microphone test is remembered per browser.
var SETUP_KEY = 'whistleMicSetup';
try { recorder.setConfig(localStorage.getItem(SETUP_KEY) || ''); } catch (e) {}

function showSetup() {
  var html = '';
  for (var i = 0; i < WhistleRecorder.CONFIGS.length; i++) {
    var c = WhistleRecorder.CONFIGS[i];
    html += '<option value="' + c.name + '"' + (c === recorder.config ? ' selected' : '') + '>' + c.name + ': ' + c.label + '</option>';
  }
  el.micSetup.innerHTML = html;
}

function chooseSetup(name) {
  if (!recorder.setConfig(name)) return;
  try { localStorage.setItem(SETUP_KEY, name); } catch (e) {}
  diag('capture setup set to ' + name);
  showSetup();
}

var testing = false;

function runMicTest() {
  if (testing || busy || recorder.state !== 'idle') return;
  testing = true;
  el.runStatus.classList.remove('error');
  setRun('Microphone test: keep talking for about 15 seconds...', 0);
  updateButtons();
  diag('--- microphone test: ' + WhistleRecorder.CONFIGS.length + ' setups, 2.5 s each; keep talking');
  recorder.probe(2500).then(function (r) {
    testing = false;
    if (r.best) {
      chooseSetup(r.best);
      setRun('Microphone test: "' + r.best + '" delivers sound and is now selected. Try Record.', 1);
    } else {
      fail('Microphone test: this browser delivered no sound with any setup. The log below has the details.');
    }
    updateButtons();
  }, function (e) {
    testing = false;
    fail('Microphone test failed: ' + (e.message || e));
  });
}

function recordingUi(on) {
  el.record.classList.toggle('recording', on);
  el.recordLabel.textContent = on ? 'Stop' : 'Record';
  if (!on) el.meter.style.width = '0%';
  updateButtons();
}

function startRecording() {
  el.runStatus.classList.remove('error');
  setRun('Waiting for microphone permission...', 0);
  diag('--- record pressed');
  // start() runs inside the tap so the browser lets the audio context run
  recorder.start().then(function () {
    recordingUi(true);
    setRun('Recording... speak, then press Stop.', 0);
  }, function (e) {
    if (e.code === 'busy') return;
    recordingUi(false);
    fail(e.message || String(e));
  });
  updateButtons();
}

function stopRecording() {
  recorder.stop().then(function (r) {
    recordingUi(false);
    return resample(r.samples, r.rate).then(function (pcm) {
      var lv = WhistleRecorder.levels(pcm);
      diag('ready for the model: ' + pcm.length + ' samples at ' + RATE + ' Hz (' + (pcm.length / RATE).toFixed(2) +
        ' s) from ' + r.source + ', peak ' + lv.peak.toFixed(4) + ', RMS ' + lv.rms.toFixed(4));
      run(pcm, r.source === 'pcm' ? 'Recording' : 'Recording (MediaRecorder)');
    });
  }, function (e) {
    if (e.code === 'ignored') return;
    recordingUi(false);
    if (e.code !== 'not-recording') fail(e.message || String(e));
  });
}

// ---------------------------------------------------------------------- UI

function updateButtons() {
  var idle = ready && !busy;
  var mic = recorder.state !== 'idle' || testing;
  el.record.disabled = !(idle || mic) || testing;
  el.micTest.disabled = busy || mic;
  el.file.disabled = !idle || mic;
  el.sample.disabled = !idle || mic;
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

function fetchFirst(urls, i) {
  return fetch(urls[i]).then(function (r) {
    if (r.ok) return r.arrayBuffer();
    if (i + 1 < urls.length) return fetchFirst(urls, i + 1);
    throw new Error('none of ' + urls.join(', ') + ' is on the server (HTTP ' + r.status + ')');
  });
}

function loadSample(urls, label) {
  setRun('Loading ' + label + '...', 0.01);
  fetchFirst(urls, 0).then(decodeFile).then(function (pcm) { run(pcm, label); }).catch(function (e) {
    fail('Could not load ' + label + ': ' + (e.message || e));
  });
}

// File.arrayBuffer() is missing on older browsers; FileReader is everywhere.
function readFile(f) {
  if (f.arrayBuffer) return f.arrayBuffer();
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(fr.result); };
    fr.onerror = function () { reject(fr.error || new Error('could not read the file')); };
    fr.readAsArrayBuffer(f);
  });
}

el.record.onclick = function () {
  if (recorder.state === 'idle') startRecording();
  else if (recorder.state === 'recording') stopRecording();
  else diag('tap ignored while ' + recorder.state);
};
el.micTest.onclick = runMicTest;
el.micSetup.onchange = function () { chooseSetup(el.micSetup.value); };
el.diagCopy.onclick = function () {
  var text = diagLines.join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
  else { var r = document.createRange(); r.selectNodeContents(el.diagLog); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); try { document.execCommand('copy'); } catch (e) {} }
  el.diagCopy.textContent = 'Copied';
  setTimeout(function () { el.diagCopy.textContent = 'Copy log'; }, 1200);
};
el.sample.onclick = function () { loadSample(SAMPLE_URLS, 'Sample clip'); };
el.file.onchange = function () {
  var f = el.file.files[0];
  if (!f) return;
  setRun('Decoding ' + f.name + '...', 0.01);
  readFile(f).then(decodeFile).then(function (pcm) { run(pcm, f.name); }).catch(function (e) {
    fail('Could not read ' + f.name + ': ' + (e.message || e));
  });
  el.file.value = '';
};
el.modelFile.onchange = function () {
  var f = el.modelFile.files[0];
  if (f) readFile(f).then(installModel);
};
el.copy.onclick = function () {
  var text = el.transcript.textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
  el.copy.textContent = 'Copied';
  setTimeout(function () { el.copy.textContent = 'Copy'; }, 1200);
};

recorder.probeEnvironment();
showSetup();
updateButtons();
fetchModel().then(installModel).catch(function (e) {
  el.modelStatus.textContent = 'Automatic model download failed (' + (e.message || e) +
    '). Choose whistle.cact from your disk:';
  el.modelPick.hidden = false;
});
})();
