#!/usr/bin/env node
/*
 * Development aid: runs the OFFICIAL engine (needle.js + needle.wasm) next to whistle.js
 * and compares transcripts and encoder outputs. The page and the library never use it.
 *
 *   node test/reference_wasm.js <dir with needle.js and needle.wasm> clip.wav [more.wav] [--language de] [--write]
 *
 * The engine files are at https://huggingface.co/Cactus-Compute/needle3/tree/main/wasm
 * --write stores each clip's reference encoder output in test/ref/<name>.embed.f32.
 */
'use strict';

var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var Whistle = require(path.join(root, 'whistle.js'));
var cli = require(path.join(root, 'whistle_cli.js'));

function cosine(a, b) {
  var d = 0, x = 0, y = 0;
  for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / Math.sqrt(x * y);
}

async function main(argv) {
  var dir = null, files = [], language = null, write = false;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--language') language = argv[++i];
    else if (argv[i] === '--write') write = true;
    else if (!dir) dir = path.resolve(argv[i]);
    else files.push(argv[i]);
  }
  if (!dir || !files.length) {
    console.log('usage: node test/reference_wasm.js <wasm dir> clip.wav [more.wav] [--language de] [--write]');
    return 1;
  }
  var cact = fs.readFileSync(path.join(root, 'whistle.cact'));
  var M = await require(path.join(dir, 'needle.js'))({ wasmBinary: fs.readFileSync(path.join(dir, 'needle.wasm')) });
  var mp = M._malloc(cact.length);
  M.HEAPU8.set(cact, mp);
  if (M._needle_load(mp, BigInt(cact.length)) < 0) throw new Error(M.UTF8ToString(M._needle_last_error()));
  var model = new Whistle.Model(cact), same = 0;

  files.forEach(function (file) {
    var wav = cli.readWav(file), pcm = cli.resample(wav.samples, wav.rate, 16000);
    var pp = M._malloc(pcm.length * 4);
    new Float32Array(M.HEAPU8.buffer, pp, pcm.length).set(pcm);
    var cos = NaN;
    if (pcm.length <= 480000) {
      var n = M._needle_embed(0, pp, pcm.length, 0, 0), po = M._malloc(n * 4);
      M._needle_embed(0, pp, pcm.length, po, n);
      var ref = new Float32Array(M.HEAPU8.buffer, po, n).slice();
      M._free(po);
      cos = cosine(model.embed(pcm).data, ref);
      if (write) fs.writeFileSync(path.join(__dirname, 'ref', path.basename(file, '.wav') + '.embed.f32'), Buffer.from(ref.buffer));
    }
    var cap = 1 << 18, out = M._malloc(cap), lp = 0;
    if (language) { lp = M._malloc(8); M.HEAPU8.set(Buffer.from(language + '\0'), lp); }
    var t0 = Date.now(), rc = M._needle_transcribe(pp, pcm.length, lp, 0, 0, out, cap), tw = Date.now() - t0;
    var theirs = rc < 0 ? { text: '<' + M.UTF8ToString(M._needle_last_error()) + '>', language: '' } : JSON.parse(M.UTF8ToString(out));
    M._free(out); M._free(pp);
    t0 = Date.now();
    var ours = model.transcribe(pcm, { language: language }), tj = Date.now() - t0;
    var ok = ours.text === theirs.text && ours.language === theirs.language;
    if (ok) same++;
    console.log((ok ? 'SAME ' : 'DIFF ') + path.basename(file) + '  ' + (pcm.length / 16000).toFixed(1) + ' s  engine ' + tw +
      ' ms, whistle.js ' + tj + ' ms' + (isNaN(cos) ? '' : ', encoder cosine ' + cos.toFixed(6)));
    console.log('   whistle.js [' + ours.language + '] ' + ours.text);
    if (!ok) console.log('   engine     [' + theirs.language + '] ' + theirs.text);
  });
  console.log(same + ' of ' + files.length + ' transcripts identical');
  return 0;
}

main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (e) { console.error(e); process.exitCode = 1; });
