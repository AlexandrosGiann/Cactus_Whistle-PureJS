#!/usr/bin/env node
/*
 * Regression test for whistle.js: node test/test.js
 *
 * The expected transcripts and encoder outputs in test/ref were produced by the
 * official engine (needle.wasm from Cactus-Compute/needle3) on the same clips;
 * test/reference_wasm.js regenerates them.
 */
'use strict';

var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var Whistle = require(path.join(root, 'whistle.js'));
var cli = require(path.join(root, 'whistle_cli.js'));

var CASES = [
  { file: 'whistle_recording_16k.wav', text: 'Hello, this is Hate Est.', language: 'en',
    embed: 'test/ref/whistle_recording_16k.embed.f32' },
  { file: 'test/audio/jfk.wav', language: 'en', embed: 'test/ref/jfk.embed.f32',
    text: 'And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.' },
  { file: 'whistle_demo_1khz.wav', text: '', language: '' }      // a steady tone is not speech
];

function f32(file) {
  var b = fs.readFileSync(file);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

function cosine(a, b) {
  var d = 0, x = 0, y = 0;
  for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / Math.sqrt(x * y);
}

var failed = 0;
function check(ok, what) {
  console.log((ok ? '  ok   ' : '  FAIL ') + what);
  if (!ok) failed++;
}

var t0 = Date.now();
var model = new Whistle.Model(fs.readFileSync(path.join(root, 'whistle.cact')));
console.log('model: ' + model.cact.numTensors + ' tensors, loaded in ' + (Date.now() - t0) + ' ms');

CASES.forEach(function (c) {
  if (!fs.existsSync(path.join(root, c.file))) { console.log(c.file + '\n  skip  not in this checkout'); return; }
  var wav = cli.readWav(path.join(root, c.file));
  console.log(c.file + ' (' + (wav.samples.length / wav.rate).toFixed(2) + ' s)');
  if (c.embed) {
    var e = model.embed(wav.samples), ref = f32(path.join(root, c.embed));
    check(e.data.length === ref.length, 'encoder output has ' + ref.length / model.hdr.width + ' frames');
    var cos = cosine(e.data, ref);
    check(cos > 0.9995, 'encoder output matches the reference engine (cosine ' + cos.toFixed(6) + ')');
  }
  var r = model.transcribe(wav.samples);
  check(r.text === c.text, 'transcript ' + JSON.stringify(r.text) + ' in ' + Math.round(r.timings.total) + ' ms');
  check(r.language === c.language, 'language ' + JSON.stringify(r.language));
});

var forced = model.transcribe(cli.readWav(path.join(root, 'test/audio/jfk.wav')).samples.subarray(0, 60000), { language: 'pl' });
check(forced.language === 'pl' && forced.text === 'And so my fellow Americans.', 'forced language keeps the transcript: ' + JSON.stringify(forced.text));

// AMR-NB through the bundled decoder: the same speech after a 12.2 kbit/s, 8 kHz round trip
var amrFile = path.join(root, 'test/audio/jfk.amr');
if (fs.existsSync(amrFile) && fs.existsSync(path.join(root, 'vendor/amrnb.js'))) {
  console.log('test/audio/jfk.amr');
  var amr = cli.readAmr(amrFile);
  check(amr.rate === 8000 && Math.abs(amr.samples.length / 8000 - 11) < 0.1, 'decodes to ' + (amr.samples.length / 8000).toFixed(2) + ' s at 8 kHz');
  var fromAmr = model.transcribe(cli.resample(amr.samples, 8000, 16000));
  check(/ask not what your country can do for you/i.test(fromAmr.text) && fromAmr.language === 'en', 'transcript ' + JSON.stringify(fromAmr.text));
} else console.log('test/audio/jfk.amr\n  skip  not in this checkout');

console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exitCode = failed ? 1 : 0;
