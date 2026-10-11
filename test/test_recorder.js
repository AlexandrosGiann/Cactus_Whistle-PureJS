#!/usr/bin/env node
/*
 * Tests for recorder.js with stand-in browser objects: node test/test_recorder.js
 *
 * These cover the recorder's decisions (which capture path is used, what is reported
 * when something goes wrong). They cannot show how a real phone's audio stack behaves.
 */
'use strict';

var path = require('path');
var lib = require(path.join(__dirname, '..', 'recorder.js')), Recorder = lib.Recorder;

var failed = 0;
function check(ok, what) { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failed++; }

// A fake browser. opts: { suspended, resumeWorks, callbacksRun, silent, mediaRecorder, mrEmpty,
//   rejectDetailed, deny, legacy, noBlobDecode, decodedSilent,
//   works(config) -> whether that capture setup carries sound }
function world(opts) {
  opts = opts || {};
  var w = { clock: 0, logs: [], timers: [], contexts: [], gumCalls: [], decoded: 0 };
  function FakeContext() {
    this.state = opts.suspended ? 'suspended' : 'running';
    this.sampleRate = 48000; this.destination = {}; this.closed = false; this.currentTime = 0;
    w.contexts.push(this); w.ctx = this;
  }
  FakeContext.prototype.resume = function () {
    if (opts.resumeWorks !== false) this.state = 'running';
    return Promise.resolve();
  };
  FakeContext.prototype.close = function () { this.closed = true; };
  FakeContext.prototype.createMediaStreamSource = function () { return { connect: function () {}, disconnect: function () {} }; };
  FakeContext.prototype.createScriptProcessor = function () { return (w.proc = { connect: function () {}, disconnect: function () {} }); };
  FakeContext.prototype.createGain = function () { return { gain: { value: 1 }, connect: function () {}, disconnect: function () {} }; };

  function FakeMediaRecorder(stream, o) { this.state = 'inactive'; this.mimeType = (o && o.mimeType) || ''; w.mr = this; }
  FakeMediaRecorder.isTypeSupported = function (t) { return t === 'audio/webm'; };
  FakeMediaRecorder.prototype.start = function () { this.state = 'recording'; };
  FakeMediaRecorder.prototype.stop = function () {
    this.state = 'inactive';
    if (!opts.mrEmpty) this.ondataavailable({ data: { size: 4321, type: 'audio/webm' } });
    this.onstop();
  };
  function FakeBlob(parts, o) { this.size = parts.reduce(function (a, p) { return a + p.size; }, 0); this.type = (o && o.type) || ''; }

  w.track = { label: 'fake mic', readyState: 'live', muted: false, stopped: false, stop: function () { this.stopped = true; } };
  var stream = { getAudioTracks: function () { return [w.track]; }, getTracks: function () { return [w.track]; } };
  function gum(c) {
    w.gumCalls.push(c);
    if (opts.deny) { var e = new Error('denied'); e.name = 'NotAllowedError'; return Promise.reject(e); }
    if (opts.rejectDetailed && c.audio !== true) { var e2 = new Error('bad constraint'); e2.name = 'OverconstrainedError'; return Promise.reject(e2); }
    return Promise.resolve(stream);
  }
  var nav = { userAgent: 'test' };
  if (opts.legacy) nav.webkitGetUserMedia = function (c, ok, bad) { gum(c).then(ok, bad); };
  else nav.mediaDevices = { getUserMedia: gum };

  w.env = {
    navigator: nav, AudioContext: FakeContext, MediaRecorder: opts.mediaRecorder ? FakeMediaRecorder : undefined,
    Blob: FakeBlob, isSecureContext: true, now: function () { return w.clock; },
    log: function (t) { w.logs.push(t); },
    setTimeout: function (f, ms) { w.timers.push({ f: f, at: w.clock + ms }); return w.timers.length; },
    clearTimeout: function (id) { if (id && w.timers[id - 1]) w.timers[id - 1].f = null; },
    decodeBlob: opts.noBlobDecode ? function () { return Promise.reject(new Error('cannot decode')); }
      : function () {
        w.decoded++;
        var loud = opts.works ? opts.works(w.rec.active) : !opts.decodedSilent;
        return Promise.resolve(new Float32Array(32000).fill(loud ? 0.1 : 0));
      },
    onEnded: function () { w.ended = (w.ended || 0) + 1; }
  };
  // advance the clock, delivering audio callbacks only while the context runs
  w.advance = function (ms) {
    var end = w.clock + ms;
    while (w.clock < end) {
      w.clock += 85;
      w.timers.forEach(function (t) { if (t.f && t.at <= w.clock) { var f = t.f; t.f = null; f(); } });
      if (w.ctx && !w.ctx.closed && w.ctx.state === 'running' && w.proc && w.proc.onaudioprocess && opts.callbacksRun !== false) {
        var d = new Float32Array(4096);
        if (opts.works ? opts.works(w.rec.active) : !opts.silent) d.fill(0.25);
        w.proc.onaudioprocess({ inputBuffer: { getChannelData: function () { return d; } } });
      }
    }
  };
  w.rec = new Recorder(w.env);
  return w;
}

function code(p) { return p.then(function () { return 'resolved'; }, function (e) { return e.code; }); }

async function main() {
  var w, r, c;

  console.log('normal capture');
  w = world({ mediaRecorder: true });
  await w.rec.start(); w.advance(2000); r = await w.rec.stop();
  check(r.source === 'pcm' && r.rate === 48000, 'PCM path is used at the context rate');
  check(Math.abs(r.seconds - 2) < 0.2 && r.samples.length === Math.round(r.seconds * 48000), 'about 2 s of samples (' + r.seconds.toFixed(2) + ' s)');
  check(w.track.stopped && w.ctx.closed && w.rec.state === 'idle', 'microphone released and context closed');
  check(w.decoded === 0, 'MediaRecorder data is not decoded when PCM is fine');

  console.log('context starts suspended (the Android failure)');
  w = world({ suspended: true });
  await w.rec.start(); w.advance(1500); r = await w.rec.stop();
  check(r.source === 'pcm' && r.seconds > 1, 'resume() wakes it and PCM arrives (' + r.seconds.toFixed(2) + ' s)');

  console.log('context stays suspended, MediaRecorder available');
  w = world({ suspended: true, resumeWorks: false, mediaRecorder: true });
  await w.rec.start(); w.advance(2000); r = await w.rec.stop();
  check(r.source === 'mediarecorder' && r.rate === 16000 && r.samples.length === 32000, 'falls back to the MediaRecorder data');
  check(w.logs.join('\n').indexOf('no audio callbacks') >= 0, 'the watchdog logged the missing callbacks');
  check(w.logs.join('\n').indexOf('audio/webm, 4321 bytes') >= 0, 'blob type and size are logged');

  console.log('context stays suspended, no MediaRecorder');
  w = world({ suspended: true, resumeWorks: false });
  await w.rec.start(); w.advance(2000); c = await code(w.rec.stop());
  check(c === 'no-audio', 'reports "no audio arrived", not "too short" (' + c + ')');
  check(w.rec.state === 'idle' && w.track.stopped, 'recorder is reusable afterwards');

  console.log('MediaRecorder data cannot be decoded');
  w = world({ suspended: true, resumeWorks: false, mediaRecorder: true, noBlobDecode: true });
  await w.rec.start(); w.advance(2000); c = await code(w.rec.stop());
  check(c === 'no-audio', 'unsupported format ends in a clear error (' + c + ')');
  w = world({ suspended: true, resumeWorks: false, mediaRecorder: true, mrEmpty: true });
  await w.rec.start(); w.advance(2000); c = await code(w.rec.stop());
  check(c === 'no-audio', 'empty MediaRecorder output ends in a clear error (' + c + ')');

  console.log('double tap and early stop');
  w = world({});
  await w.rec.start(); w.advance(100); c = await code(w.rec.stop());
  check(c === 'ignored' && w.rec.state === 'recording', 'a stop 100 ms after the start is ignored and recording continues');
  w.advance(1500); r = await w.rec.stop();
  check(r.source === 'pcm' && r.seconds > 1, 'the recording then completes normally');
  w = world({});
  var starting = w.rec.start();
  check(await code(w.rec.start()) === 'busy', 'a second start while starting is refused');
  check(await code(w.rec.stop()) === 'ignored', 'a stop while starting is ignored');
  await starting; w.advance(1000); await w.rec.stop();

  console.log('microphone problems');
  w = world({ silent: true });
  await w.rec.start(); w.advance(1500); c = await code(w.rec.stop());
  check(c === 'silent', 'all-zero input is reported as silence (' + c + ')');
  w = world({ deny: true });
  c = await code(w.rec.start());
  check(c === 'denied' && w.rec.state === 'idle' && w.ctx.closed, 'permission denial is reported and cleaned up (' + c + ')');
  w = world({ rejectDetailed: true });
  await w.rec.start(); w.advance(1000); r = await w.rec.stop();
  check(w.gumCalls.length === 2 && w.gumCalls[1].audio === true && r.source === 'pcm', 'rejected constraints are retried with audio: true');
  w = world({ legacy: true });
  await w.rec.start(); w.advance(1000); r = await w.rec.stop();
  check(r.source === 'pcm', 'the legacy callback getUserMedia works');

  console.log('track ends or time limit');
  w = world({});
  await w.rec.start(); w.advance(1000); w.track.onended();
  check(w.ended === 1, 'a track that ends on its own asks the page to stop');
  r = await w.rec.stop();
  check(r.source === 'pcm' && r.seconds > 0.8, 'what was captured before the end is kept');
  w = world({}); w.env.maxSeconds = 1;
  await w.rec.start(); w.advance(1500);
  check(w.ended >= 1, 'the time limit asks the page to stop');
  await w.rec.stop();

  console.log('silence from the browser (the Firefox on Android 5 failure)');
  w = world({ callbacksRun: false, mediaRecorder: true, decodedSilent: true });
  await w.rec.start(); w.advance(5000); c = await code(w.rec.stop());
  check(c === 'silent', 'silent MediaRecorder data is reported as silence, not sent to the model (' + c + ')');
  check(w.rec.last.callbacks === 0 && w.rec.last.blobBytes === 4321 && w.rec.last.decodedPeak === 0, 'callback count, blob size and decoded peak are kept for the report');
  check(/decoded MediaRecorder data: 32000 samples.*peak 0\.0000, RMS 0\.0000/.test(w.logs.join('\n')), 'decoded peak and RMS are logged');

  console.log('capture setups');
  w = world({ mediaRecorder: true });
  await w.rec.start(lib.CONFIGS[2]); w.advance(1000); r = await w.rec.stop();
  check(w.contexts.length === 1 && w.gumCalls[0].audio === true && r.config === 'plain-late', 'plain-late asks for audio: true and opens one context, after the stream');
  check(w.logs.join('\n').indexOf('ScriptProcessor -> destination') >= 0, 'plain-late connects the processor straight to the destination');
  w = world({ mediaRecorder: true });
  await w.rec.start(lib.CONFIGS[4]); w.advance(1000); r = await w.rec.stop();
  check(w.contexts.length === 0 && r.source === 'mediarecorder', 'recorder-only uses no AudioContext');
  w = world({});
  check(await code(w.rec.start(lib.CONFIGS[4])) === 'unsupported', 'recorder-only without MediaRecorder is refused');

  console.log('microphone test across setups');
  async function runProbe(world) {
    var result = null, spins = 0;
    world.rec.probe(2000).then(function (x) { result = x; });
    while (!result && spins++ < 600) { world.advance(170); await new Promise(function (ok) { setImmediate(ok); }); }
    return result;
  }
  w = world({ mediaRecorder: true, works: function (cfg) { return cfg.name === 'voice-late' || cfg.name === 'recorder-only'; } });
  var result = await runProbe(w);
  check(result && result.results.length === 5, 'all five setups are tried');
  check(result && result.best === 'voice-late', 'the first setup with real PCM is chosen (' + (result && result.best) + ')');
  check(result && result.results[0].error === 'silent' && result.results[3].source === 'pcm', 'each setup reports what it delivered');
  w = world({ mediaRecorder: true, works: function () { return false; } });
  result = await runProbe(w);
  check(result && result.best === null && w.rec.state === 'idle', 'no working setup is reported as such');
  check(lib.browserName('Mozilla/5.0 (Android 5.1.1; Mobile; rv:68.0) Gecko/68.0 Firefox/68.0') === 'Firefox 68.0 on Android 5.1.1', 'Firefox and Android versions are read from the user agent');

  console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
