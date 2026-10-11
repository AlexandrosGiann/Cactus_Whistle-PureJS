/*
 * Microphone capture for the Whistle demo page.
 *
 * Primary path: getUserMedia -> AudioContext -> ScriptProcessor, which hands over raw PCM
 * on every engine that has Web Audio. A MediaRecorder runs beside it where it exists and is
 * used only when the PCM path delivered nothing usable.
 *
 * Browsers disagree on which combination of constraints and audio graph actually carries
 * sound (see CONFIGS), so the combination is a parameter, and probe() can try them all on
 * the device and say which one works.
 *
 * Everything the recorder touches is passed in (navigator, constructors, clock), so the
 * logic runs unchanged under Node with stand-ins: see test/test_recorder.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WhistleRecorder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
var GHOST_CLICK_MS = 350;       // a stop this soon after the start is a double-fired tap
var MIN_SECONDS = 0.3;
var WATCHDOG_MS = 1200;         // no audio callback by then: try to wake the context again
var FINISH_TIMEOUT_MS = 2500;   // how long to wait for MediaRecorder's last chunk
var SILENCE_PEAK = 0.001;       // -60 dBFS: below this a capture holds no sound at all

var RAW = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };

// Ways to wire the microphone, tried in this order by probe().
//   constraints  what getUserMedia is asked for
//   lateContext  create the AudioContext after the stream exists instead of in the tap
//   direct       ScriptProcessor straight into the destination, no muting gain node
//   noContext    no Web Audio at all while recording: MediaRecorder only
var CONFIGS = [
  { name: 'raw', label: 'processing off, context first', constraints: { audio: RAW } },
  { name: 'plain', label: 'browser defaults, context first', constraints: { audio: true } },
  { name: 'plain-late', label: 'browser defaults, context after the stream, direct graph',
    constraints: { audio: true }, lateContext: true, direct: true },
  { name: 'voice-late', label: 'voice processing on, context after the stream, direct graph',
    constraints: { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
    lateContext: true, direct: true },
  { name: 'recorder-only', label: 'browser defaults, MediaRecorder without Web Audio',
    constraints: { audio: true }, noContext: true }
];

function configByName(name) {
  for (var i = 0; i < CONFIGS.length; i++) if (CONFIGS[i].name === name) return CONFIGS[i];
  return null;
}

function RecorderError(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

function describe(e) { return e ? (e.name ? e.name + ': ' : '') + (e.message || String(e)) : 'unknown error'; }

function levels(x) {
  var peak = 0, ss = 0;
  for (var i = 0; i < x.length; i++) { var a = x[i] < 0 ? -x[i] : x[i]; if (a > peak) peak = a; ss += a * a; }
  return { peak: peak, rms: x.length ? Math.sqrt(ss / x.length) : 0 };
}

function browserName(ua) {
  var m = /Firefox\/(\d+[\d.]*)/.exec(ua) || /(?:Chrome|CriOS)\/(\d+[\d.]*)/.exec(ua) || /Version\/(\d+[\d.]*).*Safari/.exec(ua);
  var kind = /Firefox\//.test(ua) ? 'Firefox' : /(?:Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'unknown browser';
  var os = /Android ([\d.]+)/.exec(ua);
  return kind + (m ? ' ' + m[1] : '') + (os ? ' on Android ' + os[1] : '');
}

// env: { navigator, AudioContext, MediaRecorder, Blob, now(), setTimeout, clearTimeout, log(text),
//        decodeBlob(blob) -> Promise<Float32Array at 16 kHz>, onLevel(peak, seconds), onEnded(),
//        maxSeconds, isSecureContext }
function Recorder(env) {
  this.env = env;
  this.state = 'idle';            // idle -> starting -> recording -> stopping -> idle
  this.config = CONFIGS[0];
  this.last = null;               // numbers from the most recent stop(), for reports
  this.log = env.log || function () {};
  var st = env.setTimeout, ct = env.clearTimeout;
  this.later = st ? function (f, ms) { return st(f, ms); } : function (f, ms) { return setTimeout(f, ms); };
  this.cancel = ct ? function (id) { ct(id); } : function (id) { clearTimeout(id); };
}

Recorder.prototype.setConfig = function (name) {
  var c = configByName(name);
  if (c) this.config = c;
  return !!c;
};

// What this browser offers, as log lines. Safe to call at any time.
Recorder.prototype.probeEnvironment = function () {
  var env = this.env, nav = env.navigator || {}, log = this.log, MR = env.MediaRecorder;
  log('browser: ' + browserName(nav.userAgent || ''));
  log('user agent: ' + (nav.userAgent || 'unknown'));
  log('secure context: ' + (env.isSecureContext === undefined ? 'unknown' : env.isSecureContext));
  log('getUserMedia: ' + (nav.mediaDevices && nav.mediaDevices.getUserMedia ? 'mediaDevices' :
    (nav.getUserMedia || nav.webkitGetUserMedia || nav.mozGetUserMedia) ? 'legacy callback API' : 'missing'));
  log('AudioContext: ' + (env.AudioContext ? 'yes' : 'missing'));
  if (!MR) log('MediaRecorder: missing');
  else {
    var ok = [];
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      try { if (MR.isTypeSupported && MR.isTypeSupported(MIME_CANDIDATES[i])) ok.push(MIME_CANDIDATES[i]); } catch (e) {}
    }
    log('MediaRecorder: yes, formats: ' + (ok.length ? ok.join(', ') : 'none reported'));
  }
  try {
    if (nav.mediaDevices && nav.mediaDevices.getSupportedConstraints) {
      var sc = nav.mediaDevices.getSupportedConstraints(), names = [];
      ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'channelCount', 'sampleRate'].forEach(function (k) { if (sc[k]) names.push(k); });
      log('supported audio constraints: ' + (names.join(', ') || 'none of the ones used'));
    }
  } catch (e) {}
  try {
    if (nav.permissions && nav.permissions.query) {
      nav.permissions.query({ name: 'microphone' }).then(function (p) { log('microphone permission: ' + p.state); },
        function (e) { log('microphone permission: cannot be queried (' + describe(e) + ')'); });
    } else log('microphone permission: Permissions API missing, the browser will ask on first use');
  } catch (e) { log('microphone permission: cannot be queried (' + describe(e) + ')'); }
  log('capture setup in use: ' + this.config.name + ' (' + this.config.label + ')');
};

Recorder.prototype._getUserMedia = function (constraints) {
  var nav = this.env.navigator || {};
  if (nav.mediaDevices && nav.mediaDevices.getUserMedia) return nav.mediaDevices.getUserMedia(constraints);
  var legacy = nav.getUserMedia || nav.webkitGetUserMedia || nav.mozGetUserMedia;
  if (!legacy) {
    return Promise.reject(RecorderError('unsupported', this.env.isSecureContext === false
      ? 'The browser only allows the microphone on https://. Start the server with "node serve.js --lan" and open the https:// address it prints.'
      : 'This browser has no microphone API.'));
  }
  return new Promise(function (resolve, reject) { legacy.call(nav, constraints, resolve, reject); });
};

Recorder.prototype._openContext = function (when) {
  var env = this.env, ctx = new env.AudioContext();
  this.ctx = ctx;
  this.log('AudioContext created ' + when + ': state ' + ctx.state + ', ' + ctx.sampleRate + ' Hz');
  this._resume(when);
  return ctx;
};

// Call directly from the tap handler: Chrome keeps a context created later suspended.
Recorder.prototype.start = function (config) {
  var self = this, env = this.env, log = this.log;
  if (this.state !== 'idle') {
    log('start ignored, recorder is ' + this.state);
    return Promise.reject(RecorderError('busy', 'The recorder is busy.'));
  }
  var cfg = this.active = config || this.config;
  if (cfg.noContext ? !env.MediaRecorder : !env.AudioContext) {
    return Promise.reject(RecorderError('unsupported', cfg.noContext ? 'This browser has no MediaRecorder.' : 'This browser has no Web Audio.'));
  }
  this.state = 'starting';
  this.ctx = null;
  log('capture setup: ' + cfg.name + ' (' + cfg.label + ')');
  if (!cfg.noContext && !cfg.lateContext) {
    try { this._openContext('in the tap'); } catch (e) {
      this.state = 'idle';
      return Promise.reject(RecorderError('unsupported', 'Could not open the audio system: ' + describe(e)));
    }
  }
  return this._getUserMedia(cfg.constraints).catch(function (e) {
    if (e && e.code === 'unsupported') throw e;
    var name = e && e.name;
    if (cfg.constraints.audio === true || name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') throw e;
    log('getUserMedia refused the constraints (' + describe(e) + '), retrying with audio: true');
    return self._getUserMedia({ audio: true });
  }).then(function (stream) {
    try { self._attach(stream, cfg); } catch (e) {
      self.stream = self.stream || stream;
      self._teardown();
      self.state = 'idle';
      log('could not set up capture: ' + describe(e));
      throw RecorderError('failed', 'Could not start recording: ' + describe(e));
    }
  }, function (e) {
    self._teardown();
    self.state = 'idle';
    log('getUserMedia failed: ' + describe(e));
    var name = e && e.name;
    if (e && e.code) throw e;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      throw RecorderError('denied', 'Microphone permission was denied. Allow it in the site settings and try again.');
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') throw RecorderError('no-device', 'No microphone was found.');
    throw RecorderError('failed', 'Microphone error: ' + describe(e));
  });
};

Recorder.prototype._resume = function (when) {
  var ctx = this.ctx, log = this.log;
  if (!ctx || !ctx.resume || ctx.state === 'running') return;
  try {
    var p = ctx.resume();
    if (p && p.then) p.then(function () { log('AudioContext resume ' + when + ': now ' + ctx.state); },
      function (e) { log('AudioContext resume ' + when + ' failed: ' + describe(e)); });
  } catch (e) { log('AudioContext resume ' + when + ' threw: ' + describe(e)); }
};

Recorder.prototype._attach = function (stream, cfg) {
  var self = this, env = this.env, log = this.log, i;
  this.stream = stream;
  var tracks = stream.getAudioTracks ? stream.getAudioTracks() : stream.getTracks();
  log('microphone granted: ' + tracks.length + ' audio track(s)');
  for (i = 0; i < tracks.length; i++) {
    var t = tracks[i], settings = '';
    try { if (t.getSettings) settings = ' ' + JSON.stringify(t.getSettings()); } catch (e) {}
    log('  track "' + (t.label || '?') + '" ' + t.readyState + ', enabled ' + t.enabled + ', muted ' + !!t.muted + settings);
    t.onended = function () {
      if (self.state !== 'recording') return;
      log('the microphone track ended on its own');
      if (env.onEnded) env.onEnded();
    };
    t.onmute = function () { log('the browser muted the microphone track'); };
    t.onunmute = function () { log('the browser unmuted the microphone track'); };
  }
  this.chunks = []; this.samples = 0; this.callbacks = 0; this.peak = 0; this.sumSquares = 0;

  if (!cfg.noContext) {
    var ctx = this.ctx || this._openContext('after the stream');
    this.source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but present wherever Web Audio is; old WebKit calls it JavaScriptNode.
    this.proc = ctx.createScriptProcessor ? ctx.createScriptProcessor(4096, 1, 1) : ctx.createJavaScriptNode(4096, 1, 1);
    this.proc.onaudioprocess = function (ev) {
      if (self.state !== 'recording') return;
      var d = ev.inputBuffer.getChannelData(0), peak = 0, ss = 0;
      self.chunks.push(new Float32Array(d));
      self.samples += d.length;
      self.callbacks++;
      for (var k = 0; k < d.length; k++) { var a = d[k] < 0 ? -d[k] : d[k]; if (a > peak) peak = a; ss += a * a; }
      if (peak > self.peak) self.peak = peak;
      self.sumSquares += ss;
      var secs = self.samples / ctx.sampleRate;
      if (env.onLevel) env.onLevel(peak, secs);
      if (env.maxSeconds && secs >= env.maxSeconds && env.onEnded) env.onEnded();
    };
    this.source.connect(this.proc);
    if (cfg.direct) {
      // the callback never writes its output buffer, so this plays silence
      this.proc.connect(ctx.destination);
    } else {
      this.mute = ctx.createGain ? ctx.createGain() : ctx.createGainNode();
      this.mute.gain.value = 0;
      this.proc.connect(this.mute); this.mute.connect(ctx.destination);
    }
    log('graph: microphone -> ScriptProcessor -> ' + (cfg.direct ? 'destination' : 'gain 0 -> destination'));
  }

  this.mr = null; this.mrChunks = []; this.mrType = '';
  var MR = env.MediaRecorder;
  if (MR) {
    try {
      var type = '';
      for (i = 0; i < MIME_CANDIDATES.length && !type; i++) {
        try { if (MR.isTypeSupported && MR.isTypeSupported(MIME_CANDIDATES[i])) type = MIME_CANDIDATES[i]; } catch (e) {}
      }
      var mr = type ? new MR(stream, { mimeType: type }) : new MR(stream);
      mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) self.mrChunks.push(ev.data); };
      mr.onerror = function (ev) { log('MediaRecorder error: ' + describe(ev && ev.error)); };
      mr.start();
      this.mr = mr; this.mrType = mr.mimeType || type;
      log('MediaRecorder started' + (cfg.noContext ? '' : ' as backup') + ': ' + (this.mrType || 'browser default format'));
    } catch (e) {
      log('MediaRecorder could not start (' + describe(e) + ')');
      this.mr = null;
      if (cfg.noContext) throw e;
    }
  } else log('MediaRecorder missing; PCM capture only');

  this.startedAt = env.now();
  this.state = 'recording';
  this._resume('after permission');
  if (!cfg.noContext) {
    this.watchdog = this.later(function () {
      if (self.state !== 'recording' || self.callbacks > 0) return;
      log('no audio callbacks after ' + WATCHDOG_MS + ' ms (AudioContext ' + self.ctx.state + ', currentTime ' +
        (self.ctx.currentTime === undefined ? '?' : (+self.ctx.currentTime).toFixed(2)) + ')');
      self._resume('from watchdog');
    }, WATCHDOG_MS);
  } else if (env.onLevel) {
    // nothing measures the level without Web Audio; keep the clock on the button moving
    var tick = function () {
      if (self.state !== 'recording') return;
      env.onLevel(0, (env.now() - self.startedAt) / 1000);
      self.watchdog = self.later(tick, 250);
    };
    this.watchdog = this.later(tick, 250);
  }
};

Recorder.prototype._teardown = function () {
  if (this.watchdog) this.cancel(this.watchdog);
  this.watchdog = null;
  try { if (this.proc) { this.proc.onaudioprocess = null; this.proc.disconnect(); } } catch (e) {}
  try { if (this.source) this.source.disconnect(); } catch (e) {}
  try { if (this.mute) this.mute.disconnect(); } catch (e) {}
  if (this.stream) {
    var tracks = this.stream.getTracks ? this.stream.getTracks() : [];
    for (var i = 0; i < tracks.length; i++) {
      try { tracks[i].onended = tracks[i].onmute = tracks[i].onunmute = null; tracks[i].stop(); } catch (e) {}
    }
  }
  try { if (this.ctx && this.ctx.close) this.ctx.close(); } catch (e) {}
  this.proc = this.source = this.mute = this.stream = this.ctx = this.mr = null;
};

// Resolves with the MediaRecorder blob, or null when there is none.
Recorder.prototype._finishMediaRecorder = function () {
  var self = this, mr = this.mr, env = this.env, log = this.log;
  if (!mr) return Promise.resolve(null);
  return new Promise(function (resolve) {
    var done = false, timer;
    function finish(why) {
      if (done) return;
      done = true;
      self.cancel(timer);
      if (!self.mrChunks.length) { log('MediaRecorder produced no data (' + why + ')'); resolve(null); return; }
      var blob;
      try { blob = new env.Blob(self.mrChunks, { type: self.mrType || self.mrChunks[0].type || '' }); }
      catch (e) { log('could not assemble the MediaRecorder data: ' + describe(e)); resolve(null); return; }
      log('MediaRecorder blob: ' + (blob.type || 'no type') + ', ' + blob.size + ' bytes (' + why + ')');
      resolve(blob);
    }
    timer = self.later(function () { finish('timed out waiting for stop'); }, FINISH_TIMEOUT_MS);
    mr.onstop = function () { finish('stopped'); };
    try {
      if (mr.state === 'inactive') finish('already inactive');
      else mr.stop();
    } catch (e) { finish('stop threw ' + describe(e)); }
  });
};

// Resolves with { samples, rate, source, seconds, peak, rms, config }. Rejects with an Error
// carrying .code: 'ignored' (double tap), 'not-recording', 'too-short', 'silent', 'no-audio'.
// Either way this.last holds the numbers of the attempt.
Recorder.prototype.stop = function () {
  var self = this, env = this.env, log = this.log, cfg = this.active;
  if (this.state !== 'recording') {
    log('stop ignored, recorder is ' + this.state);
    return Promise.reject(RecorderError(this.state === 'starting' ? 'ignored' : 'not-recording', 'Not recording.'));
  }
  var elapsed = (env.now() - this.startedAt) / 1000;
  if (elapsed * 1000 < GHOST_CLICK_MS) {
    log('stop ignored ' + Math.round(elapsed * 1000) + ' ms after the start (double tap)');
    return Promise.reject(RecorderError('ignored', 'Double tap ignored.'));
  }
  this.state = 'stopping';
  var ctx = this.ctx, rate = ctx ? ctx.sampleRate : 0, ctxState = ctx ? ctx.state : 'not used';
  var samples = this.samples, callbacks = this.callbacks, peak = this.peak, chunks = this.chunks;
  var rms = samples ? Math.sqrt(this.sumSquares / samples) : 0;
  var last = this.last = { config: cfg.name, elapsed: elapsed, callbacks: callbacks, pcmSamples: samples, pcmRate: rate,
    pcmPeak: peak, pcmRms: rms, contextState: ctxState, blobBytes: 0, blobType: '', decodedSamples: 0,
    decodedPeak: 0, decodedRms: 0, source: '', error: '' };
  if (ctx) {
    log('stop after ' + elapsed.toFixed(2) + ' s: ' + callbacks + ' audio callbacks, ' + samples + ' PCM samples at ' +
      rate + ' Hz (' + (samples / rate).toFixed(2) + ' s), peak ' + peak.toFixed(4) + ', RMS ' + rms.toFixed(4) +
      ', AudioContext ' + ctxState);
  } else log('stop after ' + elapsed.toFixed(2) + ' s (no Web Audio in this setup)');

  return this._finishMediaRecorder().then(function (blob) {
    self._teardown();
    if (blob) { last.blobBytes = blob.size; last.blobType = blob.type; }
    var pcmSeconds = rate ? samples / rate : 0;
    var pcmUsable = pcmSeconds >= MIN_SECONDS && peak >= SILENCE_PEAK;
    var pcmComplete = pcmUsable && pcmSeconds >= 0.6 * elapsed;
    var sawSilence = samples > 0 && peak < SILENCE_PEAK;

    function fromPcm() {
      var all = new Float32Array(samples), o = 0;
      for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], o); o += chunks[i].length; }
      log('using PCM capture: ' + samples + ' samples at ' + rate + ' Hz');
      return { samples: all, rate: rate, source: 'pcm', seconds: pcmSeconds, peak: peak, rms: rms, config: cfg.name };
    }
    function failure() {
      if (elapsed < MIN_SECONDS) return RecorderError('too-short', 'The recording is too short. Hold on for at least a second before stopping.');
      if (sawSilence) {
        return RecorderError('silent', 'The microphone is open but the browser delivered only silence (peak ' + Math.max(peak, last.decodedPeak).toFixed(4) +
          '). Open "Microphone diagnostics" and run the microphone test to look for a setup that works on this device.');
      }
      return RecorderError('no-audio', 'No audio arrived from the microphone in ' + elapsed.toFixed(1) +
        ' s (audio callbacks: ' + callbacks + ', AudioContext: ' + ctxState + '). Open "Microphone diagnostics" and run the microphone test.');
    }
    if (pcmComplete || (pcmUsable && !blob)) return fromPcm();
    if (!blob || !env.decodeBlob) {
      if (pcmUsable) return fromPcm();
      throw failure();
    }
    if (ctx) {
      log(pcmUsable ? 'PCM capture covers only ' + pcmSeconds.toFixed(2) + ' of ' + elapsed.toFixed(2) + ' s, trying the MediaRecorder data'
        : 'PCM capture is unusable, trying the MediaRecorder data');
    }
    return env.decodeBlob(blob).then(function (pcm16k) {
      var lv = levels(pcm16k);
      last.decodedSamples = pcm16k.length; last.decodedPeak = lv.peak; last.decodedRms = lv.rms;
      log('decoded MediaRecorder data: ' + pcm16k.length + ' samples at 16000 Hz (' + (pcm16k.length / 16000).toFixed(2) +
        ' s), peak ' + lv.peak.toFixed(4) + ', RMS ' + lv.rms.toFixed(4));
      if (pcm16k.length < 16000 * MIN_SECONDS) throw new Error('decoded audio is empty');
      if (lv.peak < SILENCE_PEAK) { sawSilence = true; throw new Error('decoded audio is silent'); }
      return { samples: pcm16k, rate: 16000, source: 'mediarecorder', seconds: pcm16k.length / 16000, peak: lv.peak, rms: lv.rms, config: cfg.name };
    }).catch(function (e) {
      log('MediaRecorder data could not be used: ' + describe(e));
      if (pcmUsable) return fromPcm();
      throw failure();
    });
  }).then(function (r) { self.state = 'idle'; last.source = r.source; return r; }, function (e) {
    self._teardown();
    self.state = 'idle';
    last.error = e.code || 'failed';
    log('recording failed: ' + (e.code || '') + ' ' + e.message);
    throw e;
  });
};

// Records `ms` with each setup in turn and reports what arrived. The person should keep
// talking throughout. Resolves with { results: [...], best: name or null }.
Recorder.prototype.probe = function (ms, configs) {
  var self = this, log = this.log, list = configs || CONFIGS, results = [], i = 0;
  function line(r) {
    return r.config + ': ' + (r.source ? 'SOUND via ' + r.source : 'no sound (' + r.error + ')') + ', callbacks ' + r.callbacks +
      ', PCM peak ' + r.pcmPeak.toFixed(4) + ' RMS ' + r.pcmRms.toFixed(4) + ', recorder ' + r.blobBytes + ' bytes, decoded peak ' +
      r.decodedPeak.toFixed(4) + ' RMS ' + r.decodedRms.toFixed(4);
  }
  function next() {
    if (i >= list.length) {
      var best = null, k;
      for (k = 0; k < results.length && !best; k++) if (results[k].source === 'pcm') best = results[k].config;
      for (k = 0; k < results.length && !best; k++) if (results[k].source) best = results[k].config;
      log('=== microphone test summary');
      for (k = 0; k < results.length; k++) log('  ' + line(results[k]));
      log(best ? '=== working setup: ' + best : '=== no setup delivered sound on this device and browser');
      return { results: results, best: best };
    }
    var cfg = list[i++];
    log('=== test ' + i + ' of ' + list.length + ': ' + cfg.name);
    return self.start(cfg).then(function () {
      return new Promise(function (resolve) { self.later(resolve, ms); });
    }).then(function () { return self.stop(); }).then(function () {
      results.push(self.last);
    }, function (e) {
      var r = self.last && self.last.config === cfg.name && self.last.error ? self.last
        : { config: cfg.name, callbacks: 0, pcmPeak: 0, pcmRms: 0, blobBytes: 0, decodedPeak: 0, decodedRms: 0, source: '', error: e.code || 'failed' };
      self.last = null;
      results.push(r);
      if (e.code === 'denied' || e.code === 'unsupported' && !cfg.noContext) i = list.length;   // nothing else can work
    }).then(next);
  }
  return next();
};

return { Recorder: Recorder, CONFIGS: CONFIGS, MIME_CANDIDATES: MIME_CANDIDATES, levels: levels, browserName: browserName };
});
