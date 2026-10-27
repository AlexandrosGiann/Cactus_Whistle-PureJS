/*
 * Greek for Whistle, without retraining.
 *
 * Whistle was trained on seven Latin-script languages and its vocabulary holds no
 * Greek letters. It still hears Greek well: with the Spanish language tag it writes
 * what it hears in Spanish spelling ("Calispera, mel en Alexandro..."). This module
 * steers the beam search so that the Latin text it produces must, letter by letter,
 * spell the sound of a sequence of real Greek words:
 *
 *   - every Greek word of the lexicon is turned into a phoneme string (Greek
 *     spelling is regular enough for rules: "ευχαριστώ" -> efharisto);
 *   - those strings form a trie; each beam carries the set of trie positions its
 *     Latin text can have reached, reading every Latin letter as one of the sounds
 *     it can stand for in the training languages (c = k, θ or s; j = χ or γι; ...);
 *   - a token is allowed only if it keeps at least one position alive, and the
 *     word frequencies of the lexicon are added to the acoustic score;
 *   - the Greek spelling of the words on the winning path is the transcript.
 *
 * The lexicon (greek/el_lexicon.txt) is built by tools/build_greek_lexicon.js.
 *
 * Works in browsers (window / worker: `self.WhistleGreek`) and in Node (`require`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WhistleGreek = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ------------------------------------------------------- Greek to phonemes

// One letter per phoneme: T = θ, D = δ, G = γ (before a, o, u), j = γ (before e, i), h = χ.
var PHONEMES = 'aeioupktbdgfvTDszhGjmnlr';
var NP = PHONEMES.length;
var PCODE = {};
(function () { for (var i = 0; i < NP; i++) PCODE[PHONEMES.charAt(i)] = i; })();

var BASE = { 'ά': 'α', 'έ': 'ε', 'ή': 'η', 'ί': 'ι', 'ό': 'ο', 'ύ': 'υ', 'ώ': 'ω', 'ϊ': 'ι', 'ϋ': 'υ',
  'ΐ': 'ι', 'ΰ': 'υ', 'ς': 'σ' };
var ACCENTED = 'άέήίόύώΐΰ', DIAERESIS = 'ϊϋΐΰ', VOICELESS = 'θκξπστφχψ';
var LETTER = { 'α': 'a', 'β': 'v', 'δ': 'D', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'T', 'ι': 'i', 'κ': 'k',
  'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'ks', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'τ': 't', 'υ': 'i',
  'φ': 'f', 'χ': 'h', 'ψ': 'ps', 'ω': 'o' };

// The phoneme string of a (monotonic) Greek word, or null if it holds other characters.
function g2p(word) {
  var w = word.toLowerCase().replace(/['’`\-]/g, ''), n = w.length, b = [], out = '', i;
  for (i = 0; i < n; i++) b.push(BASE[w.charAt(i)] || w.charAt(i));
  // a vowel pair is one sound unless the first is accented or the second has a diaeresis
  function pair(k) { return ACCENTED.indexOf(w.charAt(k)) < 0 && DIAERESIS.indexOf(w.charAt(k + 1)) < 0; }
  for (i = 0; i < n; i++) {
    var c = b[i], nx = b[i + 1];
    if (nx === 'ι' && (c === 'α' || c === 'ε' || c === 'ο' || c === 'υ') && pair(i)) { out += c === 'α' ? 'e' : 'i'; i++; continue; }
    if (nx === 'υ' && c === 'ο' && pair(i)) { out += 'u'; i++; continue; }
    if (nx === 'υ' && (c === 'α' || c === 'ε' || c === 'η') && pair(i)) {
      var after = b[i + 2];
      out += LETTER[c] + (after === undefined || VOICELESS.indexOf(after) >= 0 ? 'f' : 'v'); i++; continue;
    }
    if (c === 'μ' && nx === 'π') { out += 'b'; i++; continue; }
    if (c === 'ν' && nx === 'τ') { out += 'd'; i++; continue; }
    if (c === 'τ' && nx === 'ζ') { out += 'dz'; i++; continue; }
    if (c === 'γ' && (nx === 'κ' || nx === 'γ')) { out += 'g'; i++; continue; }
    if (c === 'γ' && (nx === 'χ' || nx === 'ξ')) { out += 'n'; continue; }
    if (c === 'γ') {
      var front = nx === 'ε' || nx === 'ι' || nx === 'η' || nx === 'υ' ||
        ((nx === 'α' || nx === 'ο') && b[i + 2] === 'ι' && pair(i + 1));
      out += front ? 'j' : 'G'; continue;
    }
    if (!LETTER[c]) return null;
    out += LETTER[c];
  }
  out = out.replace(/ji(?=[aeiou])/g, 'j');               // γιατί, γεια: the i is the γ itself
  var r = '';
  for (i = 0; i < out.length; i++) if (out.charAt(i) !== r.charAt(r.length - 1)) r += out.charAt(i);
  return r;                                                // double letters are said once
}

// The last two letters of a word without accents: what the grammar table looks at.
function ending(word) {
  var w = word.toLowerCase(), e = '';
  for (var i = Math.max(0, w.length - 2); i < w.length; i++) {
    var c = BASE[w.charAt(i)] || w.charAt(i);
    e += c === 'σ' && i === w.length - 1 ? 'ς' : c;
  }
  return e;
}

// ------------------------------------------------- Latin letters to phonemes

// The sounds each Latin letter can stand for in Whistle's languages. The first
// option is free, the others cost `alt`, and '' (a silent letter) costs `silent`.
var LATIN = {
  a: 'a', e: 'e', i: 'i j -', o: 'o', u: 'u - v', y: 'i j',
  b: 'b v', v: 'v b f', w: 'v u', f: 'f v',
  c: 'k T s ts', k: 'k g', q: 'k',
  d: 'd D', t: 't T d',
  g: 'G g j h', h: 'h -', j: 'h j i G', x: 'ks h',
  l: 'l j', m: 'm', n: 'n -', r: 'r',
  s: 's z T', z: 'z T s ts', p: 'p b',
  'ł': 'l u v', 'ß': 's'
};
var PUNCT = '.,?!;:';
var LATIN_OPTS = {};
(function () {
  for (var k in LATIN) {
    var parts = LATIN[k].split(' '), opts = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i] === '-' ? '' : parts[i], codes = [];
      for (var j = 0; j < s.length; j++) codes.push(PCODE[s.charAt(j)]);
      opts.push({ codes: codes, kind: s === '' ? 2 : i ? 1 : 0 });
    }
    LATIN_OPTS[k] = opts;
  }
})();

// ------------------------------------------------------------------ lexicon

// The lexicon file: a header line, then one word per line sorted by phoneme
// string, each written as <shared prefix length><cost><rest of the word>, with
// the two counts as characters from '0' (code 48) up. Cost = -ln p in units of 0.25.
function Lexicon(text) {
  var lines = text.split(/\r?\n/), header = lines[0];       // a Windows checkout may add \r
  if (header.indexOf('whistle-greek-lexicon') !== 0) throw new Error('not a Whistle Greek lexicon');
  var n = 0, total = 0, i, end = lines.length;
  // after the words: "#grammar", then <word> TAB <ending of the next word> TAB <4 x ln ratio>
  this.grammar = {};
  for (i = 1; i < lines.length; i++) {
    if (lines[i] === '#grammar') { end = i; break; }
    if (lines[i].length > 1) n++;
  }
  for (i = end + 1; i < lines.length; i++) {
    var g = lines[i].split('\t');
    if (g.length !== 3) continue;
    if (!this.grammar[g[0]]) this.grammar[g[0]] = {};
    this.grammar[g[0]][g[1]] = +g[2] / 4;
  }
  var words = new Array(n), costs = new Float32Array(n), keys = new Array(n), prev = '', k = 0;
  for (i = 1; i < end; i++) {
    var l = lines[i];
    if (l.length < 2) continue;
    var w = prev.substring(0, l.charCodeAt(0) - 48) + l.substring(2);
    words[k] = w; costs[k] = (l.charCodeAt(1) - 48) / 4;
    keys[k] = g2p(w) || '';
    total += keys[k].length;
    prev = w; k++;
  }
  var cap = total + 1;
  var first = new Int32Array(cap), next = new Int32Array(cap), label = new Uint8Array(cap);
  var parent = new Int32Array(cap), term = new Float32Array(cap), word = new Int32Array(cap);
  for (i = 0; i < cap; i++) { first[i] = -1; next[i] = -1; term[i] = Infinity; word[i] = -1; }
  var last = new Int32Array(cap), count = 1, path = [0], pk = '';
  parent[0] = -1;
  for (k = 0; k < n; k++) {
    var key = keys[k];
    if (!key) continue;
    if (key < pk) throw new Error('lexicon is not sorted by sound at "' + words[k] + '"');
    var common = 0;
    while (common < key.length && common < pk.length && key.charCodeAt(common) === pk.charCodeAt(common)) common++;
    path.length = common + 1;
    for (var d = common; d < key.length; d++) {
      var p = path[d], id = count++;
      label[id] = PCODE[key.charAt(d)]; parent[id] = p;
      if (first[p] < 0) first[p] = id; else next[last[p]] = id;
      last[p] = id;
      path.push(id);
    }
    var node = path[key.length];
    if (costs[k] < term[node]) { term[node] = costs[k]; word[node] = k; }
    pk = key;
  }
  // look[node]: the cheapest word below it, charged while the word is being spelled
  var look = new Float32Array(count);
  for (i = 0; i < count; i++) look[i] = term[i];
  for (i = count - 1; i > 0; i--) if (look[i] < look[parent[i]]) look[parent[i]] = look[i];
  look[0] = 0;
  this.first = first.subarray(0, count); this.next = next.subarray(0, count);
  this.label = label.subarray(0, count); this.term = term.subarray(0, count);
  this.word = word.subarray(0, count); this.look = look;
  this.rootChild = new Int32Array(NP);
  for (i = 0; i < NP; i++) this.rootChild[i] = -1;
  for (var c = first[0]; c >= 0; c = next[c]) this.rootChild[label[c]] = c;
  this.words = words; this.size = n; this.nodes = count;
}

Lexicon.prototype.child = function (node, code) {
  if (node === 0) return this.rootChild[code];
  for (var c = this.first[node]; c >= 0; c = this.next[c]) if (this.label[c] === code) return c;
  return -1;
};

// ------------------------------------------------------- constrained search

// A path through the lexicon: trie node, last phoneme, cost of the finished words
// plus letter penalties, and a back chain of finished words and punctuation.
function Pos(node, last, cost, back) { this.n = node; this.last = last; this.cost = cost; this.back = back; }

var DEFAULTS = { base: 'es', weight: 1, alt: 0.7, silent: 5, punct: 1, space: 1, double: 1.5, repeat: 3, grammar: 1, lengthNorm: 1, maxPaths: 48, scan: 400 };

function Decoder(lexicon, options) {
  this.lex = lexicon;
  this.opts = {};
  for (var k in DEFAULTS) this.opts[k] = options && options[k] !== undefined ? options[k] : DEFAULTS[k];
  this.tokenizer = null; this.letters = null;
}

// Each text token as the Latin letters and punctuation it adds (null: never allowed).
Decoder.prototype.prepare = function (tk) {
  if (this.tokenizer === tk) return;
  var dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null, out = [];
  for (var i = 0; i < tk.size; i++) {
    if (tk.types[i] === 2 || tk.types[i] === 4 || tk.types[i] === 1) { out.push(null); continue; }
    var s = utf8(tk.bytes[i], dec).replace(/▁/g, ' ').toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    var seq = [], ok = true;
    for (var j = 0; j < s.length; j++) {
      var ch = s.charAt(j);
      if (LATIN_OPTS[ch] || PUNCT.indexOf(ch) >= 0 || ch === ' ') seq.push(ch);
      else if (ch !== "'" && ch !== '-') { ok = false; break; }
    }
    out.push(ok ? seq : null);
  }
  this.tokenizer = tk; this.letters = out;
};

function utf8(u8, dec) {
  if (dec) return dec.decode(u8);
  var s = '';
  for (var i = 0; i < u8.length; i++) s += '%' + (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
  try { return decodeURIComponent(s); } catch (e) { return ''; }
}

Decoder.prototype.score = function (p) { return p.cost + this.lex.look[p.n]; };

// Adds, for every path that has just spelled a whole word, the path that starts the next one.
Decoder.prototype.close = function (paths) {
  var lex = this.lex, o = this.opts, n = paths.length;
  for (var i = 0; i < n; i++) {
    var p = paths[i];
    if (p.n === 0 || lex.term[p.n] === Infinity) continue;
    var cost = p.cost + lex.term[p.n], b = p.back;
    while (b && b.punct) b = b.prev;
    if (b && b.node === p.n) cost += o.repeat;            // the same word twice in a row
    if (b && o.grammar) {
      // "το παιδί", not "του παιδί": how well this word's ending suits the word before
      var rule = lex.grammar[lex.words[lex.word[b.node]].toLowerCase()];
      if (rule) { var g = rule[ending(lex.words[lex.word[p.n]])]; if (g) cost -= o.grammar * g; }
    }
    var back = { node: p.n, prev: p.back };
    paths.push(new Pos(0, p.last, cost, back));
    // "το όνομα" can come out as "tonoma": the next word may reuse the last sound
    var e = p.last >= 0 ? lex.rootChild[p.last] : -1;
    if (e >= 0) paths.push(new Pos(e, p.last, cost, back));
  }
  return paths;
};

// Keeps the cheapest path per (node, last phoneme), at most maxPaths of them.
Decoder.prototype.prune = function (paths) {
  var seen = {}, out = [], i, self = this;
  for (i = 0; i < paths.length; i++) {
    var p = paths[i], k = p.n * 32 + p.last + 1, j = seen[k];
    if (j === undefined) { seen[k] = out.length; out.push(p); }
    else if (p.cost < out[j].cost) out[j] = p;
  }
  if (out.length > this.opts.maxPaths) {
    out.sort(function (a, b) { return self.score(a) - self.score(b); });
    out.length = this.opts.maxPaths;
  }
  return out;
};

Decoder.prototype.advance = function (paths, ch) {
  var lex = this.lex, o = this.opts, out = [], i, j, k, q;
  if (ch === ' ') {
    // Whistle's own word breaks are a hint: one inside a Greek word costs `space`
    if (!o.space) return paths;
    for (i = 0; i < paths.length; i++) {
      var s = paths[i];
      out.push(s.n === 0 ? s : new Pos(s.n, s.last, s.cost + o.space, s.back));
    }
    return out;
  }
  if (PUNCT.indexOf(ch) >= 0) {
    for (i = 0; i < paths.length; i++) {
      var p0 = paths[i];
      if (p0.n === 0 && p0.back && !p0.back.punct) out.push(new Pos(0, -1, p0.cost + o.punct, { punct: ch, prev: p0.back }));
    }
    return out;
  }
  var opts = LATIN_OPTS[ch];
  for (i = 0; i < paths.length; i++) {
    for (j = 0; j < opts.length; j++) {
      var op = opts[j], extra = op.kind === 2 ? o.silent : op.kind === 1 ? o.alt : 0;
      var cur = [new Pos(paths[i].n, paths[i].last, paths[i].cost + extra, paths[i].back)];
      for (k = 0; k < op.codes.length && cur.length; k++) {
        var code = op.codes[k], nx = [];
        for (q = 0; q < cur.length; q++) {
          var t = cur[q];
          // "ll", "ss": a doubled letter is one sound (not free, or "yyyyy" would be too)
          if (code === t.last) nx.push(new Pos(t.n, t.last, t.cost + o.double, t.back));
          var c = lex.child(t.n, code);
          if (c >= 0) nx.push(new Pos(c, code, t.cost, t.back));
        }
        cur = nx;
      }
      for (q = 0; q < cur.length; q++) out.push(cur[q]);
    }
  }
  return this.prune(this.close(out));
};

Decoder.prototype.cheapest = function (paths, finished) {
  var best = null, bs = Infinity;
  for (var i = 0; i < paths.length; i++) {
    if (finished && paths[i].n !== 0) continue;
    var s = finished ? paths[i].cost : this.score(paths[i]);
    if (s < bs) { bs = s; best = paths[i]; }
  }
  return best;
};

// The Greek text of a path.
Decoder.prototype.text = function (p) {
  var parts = [], b, lex = this.lex;
  for (b = p ? p.back : null; b; b = b.prev) parts.push(b.punct ? (b.punct === '?' ? ';' : b.punct) : lex.words[lex.word[b.node]]);
  parts.reverse();
  var text = '', start = true;
  for (var i = 0; i < parts.length; i++) {
    var w = parts[i];
    if (PUNCT.indexOf(w) >= 0) { text += w; start = w === '.' || w === ';' || w === '!'; continue; }
    if (start) w = w.charAt(0).toUpperCase() + w.substring(1);
    text += (text ? ' ' : '') + w;
    start = false;
  }
  return text;
};

// True if the tail of the tokens repeats with a period of 1..8 four times over
// (the same test as repetitionCut in whistle.js).
function repeats(t) {
  var n = t.length;
  for (var p = 1; p <= 8 && 4 * p <= n; p++) {
    var ok = true;
    for (var c = n - 4 * p; c < n - p; c++) if (t[c] !== t[c + p]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

// Beam search over one encoded clip (see Model.prototype.decode in whistle.js).
Decoder.prototype.decode = function (model, enc, frames, opts) {
  opts = opts || {};
  var o = this.opts, dec = model.decoder, tk = model.tokenizer, textVocab = model.cfg.textVocab;
  this.prepare(tk);
  var letters = this.letters, wt = o.weight;
  var beamWidth = opts.beams || 5, perBeam = beamWidth + 1, maxLen = model.hdr.maxSeq - 1;
  var lang = model.languages.indexOf(o.base);
  if (lang < 0) throw new Error('Greek decoding needs the "' + o.base + '" language tag');
  var cross = dec.prepareCross(enc, frames), st0 = dec.newState(), i, b;
  dec.step(st0, tk.bosId, cross);
  var beams = [{ state: st0, tokens: [], ac: 0, paths: [new Pos(0, -1, 0, null)] }];
  var best = null, bestScore = -1e30, finished = 0, steps = 0, self = this;
  var order = new Int32Array(textVocab);
  while (beams.length && finished < beamWidth) {
    var cands = [];
    for (b = 0; b < beams.length; b++) {
      var bm = beams[b], input = bm.tokens.length ? bm.tokens[bm.tokens.length - 1] : textVocab + lang;
      var lg = dec.step(bm.state, input, cross);
      var mx = -Infinity, sum = 0, m = 0;
      for (i = 0; i < textVocab; i++) if (lg[i] > mx) mx = lg[i];
      for (i = 0; i < textVocab; i++) sum += Math.exp(lg[i] - mx);
      var lse = Math.log(sum) + mx;
      for (i = 0; i < textVocab; i++) if (lg[i] - lse > -14) order[m++] = i;
      var top = Array.prototype.slice.call(order.subarray(0, m));
      top.sort(function (x, y) { return lg[y] - lg[x]; });
      var found = 0;
      for (var q = 0; q < top.length && q < o.scan && found < perBeam; q++) {
        var t = top[q], ac = bm.ac + lg[t] - lse, end, paths;
        if (t === tk.eosId) {
          end = this.cheapest(bm.paths, true);
          if (!end) continue;
          cands.push({ total: ac - wt * end.cost, ac: ac, beam: b, token: t, paths: [end], eos: true });
          found++;
          continue;
        }
        var seq = letters[t];
        if (!seq) continue;
        paths = bm.paths;
        for (i = 0; i < seq.length && paths.length; i++) paths = this.advance(paths, seq[i]);
        if (!paths.length) continue;
        end = this.cheapest(paths, false);
        cands.push({ total: ac - wt * this.score(end), ac: ac, beam: b, token: t, paths: paths });
        found++;
      }
    }
    cands.sort(function (x, y) { return y.total - x.total; });
    var next = [], used = [];
    for (i = 0; i < cands.length && next.length < beamWidth; i++) {
      var c = cands[i], toks = beams[c.beam].tokens.slice(), done = !!c.eos;
      if (!done) {
        toks.push(c.token);
        if (repeats(toks)) continue;                  // a looping hypothesis is dropped
        done = toks.length >= maxLen;
      }
      if (!done) { next.push({ parent: c.beam, tokens: toks, ac: c.ac, paths: c.paths }); continue; }
      if (finished === beamWidth) continue;
      // the acoustic score per token, as in whistle.js; the word costs are added whole (lengthNorm 0) or per token (1)
      var norm = o.lengthNorm ? c.total / (toks.length || 1) : c.ac / (toks.length || 1) + (c.total - c.ac);
      if (norm > bestScore) { bestScore = norm; best = { tokens: toks, path: this.cheapest(c.paths, !!c.eos) || c.paths[0] }; }
      finished++;
    }
    for (i = 0; i < next.length; i++) {
      var p = next[i].parent;
      next[i].state = used[p] ? dec.cloneState(beams[p].state) : beams[p].state;
      used[p] = true;
    }
    beams = next;
    steps++;
    if (opts.onStep) {
      opts.onStep(steps, best ? self.text(best.path) : beams.length ? self.text(self.cheapest(beams[0].paths, false)) : '');
    }
  }
  return {
    tokens: best ? best.tokens : [], text: best ? this.text(best.path) : '', latin: best ? tk.decode(best.tokens) : '',
    language: 'el', score: bestScore, steps: steps
  };
};

return { g2p: g2p, ending: ending, Lexicon: Lexicon, Decoder: Decoder, PHONEMES: PHONEMES, DEFAULTS: DEFAULTS };
});
