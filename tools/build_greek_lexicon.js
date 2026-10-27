#!/usr/bin/env node
/*
 * Builds greek/el_lexicon.txt, the word list greek.js decodes Greek with.
 *
 *   node tools/build_greek_lexicon.js --dic el_GR.dic [--corpus DIR ...] [--common greek/el_common.txt]
 *        [--mix 0.6,0.3,0.1] [--cache counts.tsv] [--out greek/el_lexicon.txt]
 *
 * Word probabilities mix three sources:
 *   --common  a hand-written list of everyday Greek words, most frequent first (Zipf by rank);
 *   --corpus  word counts from Greek text found under the given folders (UTF-8 or UTF-16
 *             files, square-rooted so a few very repetitive texts do not dominate);
 *   --dic     a Hunspell dictionary with every inflected form (the elspell el_GR.dic that
 *             LibreOffice ships), each word getting the same small share.
 * Words that sound the same are merged: the sound gets the summed probability and the
 * most probable spelling.
 */
'use strict';

var fs = require('fs'), path = require('path');
var Greek = require(path.join(__dirname, '..', 'greek.js'));

function args(argv) {
  var o = { corpus: [], common: path.join(__dirname, '..', 'greek', 'el_common.txt'),
    out: path.join(__dirname, '..', 'greek', 'el_lexicon.txt'), mix: [0.6, 0.3, 0.1], contexts: 150 };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--dic') o.dic = argv[++i];
    else if (a === '--corpus') o.corpus.push(argv[++i]);
    else if (a === '--common') o.common = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--mix') o.mix = argv[++i].split(',').map(Number);
    else if (a === '--cache') o.cache = argv[++i];
    else if (a === '--contexts') o.contexts = +argv[++i];
    else throw new Error('unknown option ' + a);
  }
  if (!o.dic) throw new Error('usage: node tools/build_greek_lexicon.js --dic el_GR.dic [--corpus DIR] [--common FILE] [--mix a,b,c] [--out FILE]');
  return o;
}

// Hunspell .dic: a count line, then one word per line (flags after '/'); the
// encoding is the SET line of the .aff file next to it.
function readDic(file) {
  var enc = 'ISO-8859-7', aff = file.replace(/\.dic$/i, '.aff');
  if (fs.existsSync(aff)) {
    var m = /^SET\s+(\S+)/m.exec(fs.readFileSync(aff, 'latin1'));
    if (m) enc = m[1];
  }
  var text = new TextDecoder(enc.toLowerCase()).decode(fs.readFileSync(file));
  return text.split(/\r?\n/).slice(1).map(function (l) { return l.split('/')[0].trim(); }).filter(Boolean);
}

var TEXT_FILE = /\.(mui|xml|txt|html?|js|json|resw|resx|ini|inf|adml|strings)$/i;
// Word counts, and counts of (word, ending of the next word) for the grammar table.
function countCorpus(dirs) {
  var counts = new Map(), pairs = new Map(), files = 0, words = 0;
  function walk(d) {
    var ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach(function (e) {
      var p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); return; }
      if (!TEXT_FILE.test(e.name)) return;
      var b;
      try { b = fs.readFileSync(p); } catch (x) { return; }
      if (b.length > 20e6) return;
      files++;
      [b.toString('utf16le'), b.toString('utf8')].forEach(function (s) {
        var runs = s.match(/[Ά-ώ]+(?: [Ά-ώ]+)*/g) || [];
        runs.forEach(function (run) {
          var ws = run.toLowerCase().split(' ');
          for (var i = 0; i < ws.length; i++) {
            counts.set(ws[i], (counts.get(ws[i]) || 0) + 1); words++;
            if (i) { var k = ws[i - 1] + '\t' + Greek.ending(ws[i]); pairs.set(k, (pairs.get(k) || 0) + 1); }
          }
        });
      });
    });
  }
  dirs.forEach(walk);
  console.log('corpus: ' + files + ' files, ' + words + ' Greek words, ' + counts.size + ' distinct');
  return { counts: counts, pairs: pairs };
}

// For the most frequent words, how much more (or less) likely each ending of the
// next word is after them than overall: ln P(ending | word) / P(ending), kept when
// it matters. "το" is followed by "-ι"/"-ο"/"-μα" nouns, "του" by "-ου" and "-ή".
function grammarTable(pairs, contexts) {
  var byWord = new Map(), endings = new Map(), total = 0;
  pairs.forEach(function (n, k) {
    var t = k.split('\t');
    endings.set(t[1], (endings.get(t[1]) || 0) + n); total += n;
    if (!byWord.has(t[0])) byWord.set(t[0], { n: 0, e: new Map() });
    var w = byWord.get(t[0]); w.n += n; w.e.set(t[1], n);
  });
  var words = Array.from(byWord.keys()).sort(function (a, b) { return byWord.get(b).n - byWord.get(a).n; }).slice(0, contexts);
  var rows = [], A = 20;
  words.forEach(function (w) {
    var c = byWord.get(w);
    if (c.n < 200) return;
    endings.forEach(function (ne, e) {
      if (ne < 50) return;
      var pe = ne / total, g = Math.log(((c.e.get(e) || 0) + A * pe) / (c.n + A) / pe);
      g = Math.max(-1.5, Math.min(2, g));          // the text is technical: do not trust it too far
      if (Math.abs(g) >= 0.25) rows.push(w + '\t' + e + '\t' + Math.round(g * 4));
    });
  });
  return rows;
}

// --cache keeps the corpus counts, so rebuilding with other settings skips the scan
function writeCache(file, cp) {
  var lines = ['#words'];
  cp.counts.forEach(function (n, w) { lines.push(w + '\t' + n); });
  lines.push('#pairs');
  cp.pairs.forEach(function (n, k) { lines.push(k + '\t' + n); });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}
function readCache(file) {
  var cp = { counts: new Map(), pairs: new Map() }, into = null;
  fs.readFileSync(file, 'utf8').split('\n').forEach(function (l) {
    if (l === '#words') { into = cp.counts; return; }
    if (l === '#pairs') { into = cp.pairs; return; }
    var t = l.lastIndexOf('\t');
    if (t > 0 && into) into.set(l.substring(0, t), +l.substring(t + 1));
  });
  return cp;
}

function main() {
  var o = args(process.argv.slice(2));
  var dic = readDic(o.dic);
  var common = fs.readFileSync(o.common, 'utf8').split('\n')
    .filter(function (l) { return l.charAt(0) !== '#'; }).join(' ').split(/\s+/).filter(Boolean);
  var cp;
  if (o.cache && fs.existsSync(o.cache)) cp = readCache(o.cache);
  else { cp = countCorpus(o.corpus); if (o.cache) writeCache(o.cache, cp); }
  var corpus = cp.counts;
  console.log('dictionary: ' + dic.length + ' words, common list: ' + common.length + ' words');

  var lc = function (w) { return w.toLowerCase(); };
  var spelling = new Map();                  // lower case -> spelling (lower case wins, then the list's)
  dic.forEach(function (w) { var l = lc(w); if (!spelling.has(l) || w === l) spelling.set(l, w); });
  common.forEach(function (w) {
    var l = lc(w);
    if (w !== l) spelling.set(l, w);         // names in the list keep their capital
    else if (!spelling.has(l)) spelling.set(l, w);
  });

  var pc = new Map(), rank = 0, H = 0, r;
  common.forEach(function (w) { if (!pc.has(lc(w))) pc.set(lc(w), rank++); });
  for (r = 0; r < rank; r++) H += 1 / (r + 10);
  var T = 0;
  corpus.forEach(function (n, w) { if (n >= 2 && spelling.has(w)) T += Math.sqrt(n); });
  var N = dic.length;

  var bySound = new Map();
  spelling.forEach(function (w, l) {
    var key = Greek.g2p(w);
    if (!key) return;
    var p = o.mix[2] / N;
    if (pc.has(l)) p += o.mix[0] / (pc.get(l) + 10) / H;
    var n = corpus.get(l);
    if (n >= 2 && T) p += o.mix[1] * Math.sqrt(n) / T;
    var s = bySound.get(key);
    if (!s) bySound.set(key, { word: w, p: p, sum: p });
    else { s.sum += p; if (p > s.p) { s.p = p; s.word = w; } }
  });

  var keys = Array.from(bySound.keys()).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
  var out = ['whistle-greek-lexicon 1 ' + keys.length + ' mix=' + o.mix.join(',')], prev = '';
  var grammar = grammarTable(cp.pairs, o.contexts);
  keys.forEach(function (k) {
    var e = bySound.get(k), w = e.word, cost = Math.min(200, Math.round(-Math.log(e.sum) * 4)), c = 0;
    while (c < w.length && c < prev.length && c < 60 && w.charCodeAt(c) === prev.charCodeAt(c)) c++;
    out.push(String.fromCharCode(48 + c) + String.fromCharCode(48 + cost) + w.substring(c));
    prev = w;
  });
  out.push('#grammar');
  out = out.concat(grammar);
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(o.out, out.join('\n') + '\n');
  console.log('wrote ' + o.out + ': ' + keys.length + ' sounds, ' + grammar.length + ' grammar rows, ' + fs.statSync(o.out).size + ' bytes');
}

main();
