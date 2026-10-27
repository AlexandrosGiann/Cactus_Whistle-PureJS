#!/usr/bin/env node
/* Command line front end: node whistle_cli.js clip.wav|clip.amr [--language en|el] [--greedy] [--json] [--model whistle.cact] */
'use strict';

var fs = require('fs'), path = require('path');
var Whistle = require('./whistle.js');

// PCM 8/16/24/32-bit or 32-bit float WAV, any channel count -> mono float samples.
function readWav(file) {
  var b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(file + ' is not a WAV file');
  var p = 12, fmt = null;
  while (p + 8 <= b.length) {
    var id = b.toString('ascii', p, p + 4), len = b.readUInt32LE(p + 4), body = p + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
      if (fmt.format === 0xfffe && len >= 26) fmt.format = b.readUInt16LE(body + 24);
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt');
      var bytes = fmt.bits >> 3, ch = fmt.channels, n = Math.floor(Math.min(len, b.length - body) / (bytes * ch));
      var out = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var s = 0;
        for (var c = 0; c < ch; c++) {
          var o = body + (i * ch + c) * bytes;
          if (fmt.format === 3) s += bytes === 8 ? b.readDoubleLE(o) : b.readFloatLE(o);
          else if (bytes === 1) s += (b[o] - 128) / 128;
          else if (bytes === 2) s += b.readInt16LE(o) / 32768;
          else if (bytes === 3) s += b.readIntLE(o, 3) / 8388608;
          else s += b.readInt32LE(o) / 2147483648;
        }
        out[i] = s / ch;
      }
      return { samples: out, rate: fmt.rate };
    }
    p = body + len + (len & 1);
  }
  throw new Error('WAV data chunk missing');
}

// AMR-NB (.amr, as phone voice recorders write it) through the bundled opencore-amr build.
// The library is a browser script, so it runs in its own context here.
var amrLib = null;
function readAmr(file) {
  var bytes = new Uint8Array(fs.readFileSync(file));
  if (Buffer.from(bytes.subarray(0, 9)).toString('latin1') === '#!AMR-WB\n') throw new Error(file + ' is AMR-WB; only AMR-NB is supported');
  if (Buffer.from(bytes.subarray(0, 6)).toString('latin1') !== '#!AMR\n') throw new Error(file + ' is not an AMR-NB file');
  if (!amrLib) {
    // a fresh context brings its own typed arrays, which is what asm.js validation expects
    var vm = require('vm'), box = { console: { log: function () {}, warn: function () {}, error: function () {} } };
    box.window = box; box.self = box;
    vm.createContext(box);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'vendor', 'amrnb.js'), 'utf8'), box, { filename: 'amrnb.js' });
    amrLib = box.AMR;
  }
  var pcm = amrLib.decode(bytes);
  if (!pcm || !pcm.length) throw new Error(file + ' holds no decodable AMR frames');
  return { samples: Float32Array.from(pcm), rate: 8000 };
}

function readAudio(file) { return /\.amr$/i.test(file) ? readAmr(file) : readWav(file); }

// Windowed-sinc resampler, good enough for speech when the file is not 16 kHz.
function resample(x, from, to) {
  if (from === to) return x;
  var ratio = from / to, n = Math.round(x.length / ratio), out = new Float32Array(n);
  var cutoff = Math.min(1, to / from), half = 16;
  for (var i = 0; i < n; i++) {
    var c = i * ratio, lo = Math.ceil(c - half / cutoff), hi = Math.floor(c + half / cutoff), acc = 0, wsum = 0;
    for (var j = lo; j <= hi; j++) {
      if (j < 0 || j >= x.length) continue;
      var t = (j - c) * cutoff, w = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      w *= 0.5 + 0.5 * Math.cos(Math.PI * t / half);
      acc += x[j] * w; wsum += w;
    }
    out[i] = wsum ? acc / wsum : 0;
  }
  return out;
}

function main(argv) {
  var opts = { model: path.join(__dirname, 'whistle.cact'), files: [] };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--language' || a === '-l') opts.language = argv[++i];
    else if (a === '--model' || a === '-m') opts.model = argv[++i];
    else if (a === '--greedy') opts.beams = 1;
    else if (a === '--beams') opts.beams = +argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.files.push(a);
  }
  if (opts.help || !opts.files.length) {
    console.log('usage: node whistle_cli.js clip.wav|clip.amr [more] [--language en|de|fr|es|it|nl|pl|el] [--greedy] [--json] [--model whistle.cact]');
    return opts.help ? 0 : 1;
  }
  var model = new Whistle.Model(fs.readFileSync(opts.model));
  if (opts.language === 'el') {
    // Greek: the decoder of greek.js and its word list (see the README)
    var Greek = require('./greek.js');
    model.greek = new Greek.Decoder(new Greek.Lexicon(fs.readFileSync(path.join(__dirname, 'greek', 'el_lexicon.txt'), 'utf8')));
  }
  opts.files.forEach(function (file) {
    var wav = readAudio(file), pcm = resample(wav.samples, wav.rate, 16000);
    var r = model.transcribe(pcm, { language: opts.language, beams: opts.beams });
    if (opts.json) {
      console.log(JSON.stringify({ file: file, text: r.text, language: r.language, seconds: pcm.length / 16000,
        ms: Math.round(r.timings.total) }));
    } else {
      console.log(r.silent ? '(no speech)' : r.text);
      console.error('  ' + path.basename(file) + ': ' + (pcm.length / 16000).toFixed(2) + ' s of audio, ' +
        (r.language || 'no language') + ', ' + (r.timings.total / 1000).toFixed(2) + ' s');
    }
  });
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { readWav: readWav, readAmr: readAmr, readAudio: readAudio, resample: resample };
