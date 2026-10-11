/*
 * Microphone capture for the Whistle demo page.
 *
 * Primary path: getUserMedia -> AudioContext -> ScriptProcessor, which hands over raw PCM
 * on every engine that has Web Audio. A MediaRecorder runs beside it where it exists and is
 * used only when the PCM path delivered nothing usable (for example an AudioContext the
 * browser kept suspended).
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

function RecorderError(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

function describe(e) { return e ? (e.name ? e.name + ': ' : '') + (e.message || String(e)) : 'unknown error'; }

// env: { navigator, AudioContext, MediaRecorder, Blob, now(), setTimeout, clearTimeout, log(text),
//        decodeBlob(blob) -> Promise<Float32Array at 16 kHz>, onLevel(peak, seconds), onEnded(),
//        maxSeconds }
function Recorder(env) {
  this.env = env;
  this.state = 'idle';            // idle -> starting -> recording -> stopping -> idle
  this.log = env.log || function () {};
  this.setTimeout = env.setTimeout || setTimeout;
  this.clearTimeout = env.clearTimeout || clearTimeout;
}

// What this browser offers, as log lines. Safe to call at any time.
Recorder.prototype.probe = function () {
  var env = this.env, nav = env.navigator || {}, log = this.log, MR = env.MediaRecorder;
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
    if (nav.permissions && nav.permissions.query) {
      nav.permissions.query({ name: 'microphone' }).then(function (p) { log('microphone permission: ' + p.state); },
        function (e) { log('microphone permission: cannot be queried (' + describe(e) + ')'); });
    } else log('microphone permission: Permissions API missing, the browser will ask on first use');
  } catch (e) { log('microphone permission: cannot be queried (' + describe(e) + ')'); }
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

// Must be called directly from the tap handler: a context created later starts suspended.
Recorder.prototype.start = function () {
  var self = this, env = this.env, log = this.log;
  if (this.state !== 'idle') {
    log('start ignored, recorder is ' + this.state);
    return Promise.reject(RecorderError('busy', 'The recorder is busy.'));
  }
  if (!env.AudioContext) return Promise.reject(RecorderError('unsupported', 'This browser has no Web Audio.'));
  this.state = 'starting';
  var ctx;
  try { ctx = new env.AudioContext(); } catch (e) {
    this.state = 'idle';
    return Promise.reject(RecorderError('unsupported', 'Could not open the audio system: ' + describe(e)));
  }
  this.ctx = ctx;
  log('AudioContext created: state ' + ctx.state + ', ' + ctx.sampleRate + ' Hz');
  this._resume('at start');

  var wanted = { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
  return this._getUserMedia(wanted).catch(function (e) {
    if (e && e.code === 'unsupported') throw e;
    var name = e && e.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') throw e;
    log('getUserMedia refused the detailed constraints (' + describe(e) + '), retrying with audio: true');
    return self._getUserMedia({ audio: true });
  }).then(function (stream) {
    try { self._attach(stream); } catch (e) {
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

Recorder.prototype._attach = function (stream) {
  var self = this, env = this.env, ctx = this.ctx, log = this.log, i;
  this.stream = stream;
  var tracks = stream.getAudioTracks ? stream.getAudioTracks() : stream.getTracks();
  log('microphone granted: ' + tracks.length + ' audio track(s)');
  for (i = 0; i < tracks.length; i++) {
    var t = tracks[i], settings = '';
    try { if (t.getSettings) settings = ' ' + JSON.stringify(t.getSettings()); } catch (e) {}
    log('  track "' + (t.label || '?') + '" ' + t.readyState + (t.muted ? ' (muted)' : '') + settings);
    t.onended = function () {
      if (self.state !== 'recording') return;
      log('the microphone track ended on its own');
      if (env.onEnded) env.onEnded();
    };
  }
  this.chunks = []; this.samples = 0; this.callbacks = 0; this.peak = 0;
  this.source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but present wherever Web Audio is; old WebKit calls it JavaScriptNode.
  this.proc = ctx.createScriptProcessor ? ctx.createScriptProcessor(4096, 1, 1) : ctx.createJavaScriptNode(4096, 1, 1);
  this.mute = ctx.createGain ? ctx.createGain() : ctx.createGainNode();
  this.mute.gain.value = 0;
  this.proc.onaudioprocess = function (ev) {
    if (self.state !== 'recording') return;
    var d = ev.inputBuffer.getChannelData(0), peak = 0;
    self.chunks.push(new Float32Array(d));
    self.samples += d.length;
    self.callbacks++;
    for (var k = 0; k < d.length; k += 8) { var a = d[k] < 0 ? -d[k] : d[k]; if (a > peak) peak = a; }
    if (peak > self.peak) self.peak = peak;
    var secs = self.samples / ctx.sampleRate;
    if (env.onLevel) env.onLevel(peak, secs);
    if (env.maxSeconds && secs >= env.maxSeconds && env.onEnded) env.onEnded();
  };
  this.source.connect(this.proc); this.proc.connect(this.mute); this.mute.connect(ctx.destination);

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
      log('MediaRecorder started as backup: ' + (this.mrType || 'browser default format'));
    } catch (e) {
      log('MediaRecorder could not start (' + describe(e) + '); PCM capture only');
      this.mr = null;
    }
  } else log('MediaRecorder missing; PCM capture only');

  this.startedAt = env.now();
  this.state = 'recording';
  this._resume('after permission');
  this.watchdog = this.setTimeout.call(null, function () {
    if (self.state !== 'recording' || self.callbacks > 0) return;
    log('no audio callbacks after ' + WATCHDOG_MS + ' ms (AudioContext ' + ctx.state + ')');
    self._resume('from watchdog');
  }, WATCHDOG_MS);
};

Recorder.prototype._teardown = function () {
  if (this.watchdog) this.clearTimeout.call(null, this.watchdog);
  this.watchdog = null;
  try { if (this.proc) { this.proc.onaudioprocess = null; this.proc.disconnect(); } } catch (e) {}
  try { if (this.source) this.source.disconnect(); } catch (e) {}
  try { if (this.mute) this.mute.disconnect(); } catch (e) {}
  if (this.stream) {
    var tracks = this.stream.getTracks ? this.stream.getTracks() : [];
    for (var i = 0; i < tracks.length; i++) { try { tracks[i].onended = null; tracks[i].stop(); } catch (e) {} }
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
      self.clearTimeout.call(null, timer);
      if (!self.mrChunks.length) { log('MediaRecorder produced no data (' + why + ')'); resolve(null); return; }
      var blob;
      try { blob = new env.Blob(self.mrChunks, { type: self.mrType || self.mrChunks[0].type || '' }); }
      catch (e) { log('could not assemble the MediaRecorder data: ' + describe(e)); resolve(null); return; }
      log('MediaRecorder blob: ' + (blob.type || 'no type') + ', ' + blob.size + ' bytes (' + why + ')');
      resolve(blob);
    }
    timer = self.setTimeout.call(null, function () { finish('timed out waiting for stop'); }, FINISH_TIMEOUT_MS);
    mr.onstop = function () { finish('stopped'); };
    try {
      if (mr.state === 'inactive') finish('already inactive');
      else mr.stop();
    } catch (e) { finish('stop threw ' + describe(e)); }
  });
};

// Resolves with { samples, rate, source, seconds }. Rejects with an Error carrying .code:
// 'ignored' (double tap), 'not-recording', 'too-short', 'silent', 'no-audio'.
Recorder.prototype.stop = function () {
  var self = this, env = this.env, log = this.log;
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
  var ctx = this.ctx, rate = ctx.sampleRate, ctxState = ctx.state;
  var samples = this.samples, callbacks = this.callbacks, peak = this.peak, chunks = this.chunks;
  log('stop after ' + elapsed.toFixed(2) + ' s: ' + callbacks + ' audio callbacks, ' + samples + ' PCM samples at ' +
    rate + ' Hz (' + (samples / rate).toFixed(2) + ' s), peak ' + peak.toFixed(4) + ', AudioContext ' + ctxState);

  return this._finishMediaRecorder().then(function (blob) {
    self._teardown();
    var pcmSeconds = samples / rate;
    var pcmUsable = pcmSeconds >= MIN_SECONDS && peak > 0;
    var pcmComplete = pcmUsable && pcmSeconds >= 0.6 * elapsed;

    function fromPcm() {
      var all = new Float32Array(samples), o = 0;
      for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], o); o += chunks[i].length; }
      log('using PCM capture: ' + samples + ' samples at ' + rate + ' Hz');
      return { samples: all, rate: rate, source: 'pcm', seconds: pcmSeconds };
    }
    function failure() {
      if (elapsed < MIN_SECONDS) return RecorderError('too-short', 'The recording is too short. Hold on for at least a second before stopping.');
      if (samples > 0 && peak === 0) {
        return RecorderError('silent', 'The microphone delivered only silence. Check that no other app is using it and that the browser has microphone access.');
      }
      return RecorderError('no-audio', 'No audio arrived from the microphone in ' + elapsed.toFixed(1) +
        ' s (audio callbacks: ' + callbacks + ', AudioContext: ' + ctxState + '). Open "Microphone diagnostics" below for details.');
    }
    if (pcmComplete || (pcmUsable && !blob)) return fromPcm();
    if (!blob || !env.decodeBlob) {
      if (pcmUsable) return fromPcm();
      throw failure();
    }
    log(pcmUsable ? 'PCM capture covers only ' + pcmSeconds.toFixed(2) + ' of ' + elapsed.toFixed(2) + ' s, trying the MediaRecorder data'
      : 'PCM capture is unusable, trying the MediaRecorder data');
    return env.decodeBlob(blob).then(function (pcm16k) {
      log('decoded MediaRecorder data: ' + pcm16k.length + ' samples at 16000 Hz (' + (pcm16k.length / 16000).toFixed(2) + ' s)');
      if (pcm16k.length < 16000 * MIN_SECONDS) throw new Error('decoded audio is empty');
      return { samples: pcm16k, rate: 16000, source: 'mediarecorder', seconds: pcm16k.length / 16000 };
    }).catch(function (e) {
      log('MediaRecorder data could not be used: ' + describe(e));
      if (pcmUsable) return fromPcm();
      throw failure();
    });
  }).then(function (r) { self.state = 'idle'; return r; }, function (e) {
    self._teardown();
    self.state = 'idle';
    log('recording failed: ' + (e.code || '') + ' ' + e.message);
    throw e;
  });
};

return { Recorder: Recorder, MIME_CANDIDATES: MIME_CANDIDATES };
});
