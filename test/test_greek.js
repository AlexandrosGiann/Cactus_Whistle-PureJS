#!/usr/bin/env node
/*
 * Tests for greek.js: node test/test_greek.js
 *
 * The clips in test/audio/el_*.wav were made with the Greek voice of Windows
 * (Microsoft Stefanos). Their expected transcripts in test/ref/greek.json are what
 * greek.js produced when the word list and settings were last tuned, mistakes
 * included ("spoken" holds what was said), so a change in either shows up here.
 */
'use strict';

var fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..');
var Whistle = require(path.join(root, 'whistle.js'));
var Greek = require(path.join(root, 'greek.js'));
var cli = require(path.join(root, 'whistle_cli.js'));

var failed = 0;
function check(ok, what) {
  console.log((ok ? '  ok   ' : '  FAIL ') + what);
  if (!ok) failed++;
}

console.log('Greek spelling to sound');
[
  ['καλησπέρα', 'kalispera'], ['ευχαριστώ', 'efharisto'], ['αύριο', 'avrio'], ['παιδί', 'peDi'],
  ['είναι', 'ine'], ['μπορείς', 'boris'], ['ντομάτα', 'domata'], ['γεια', 'ja'], ['γιατί', 'jati'],
  ['θάλασσα', 'Talasa'], ['αγγούρι', 'aguri'], ['τσάι', 'tsai'], ['κοροϊδεύω', 'koroiDevo'],
  ['ξέρω', 'ksero'], ['ψωμί', 'psomi'], ['γάλα', 'Gala'], ['Αθήνα', 'aTina'], ['hello', null]
].forEach(function (c) {
  var got = Greek.g2p(c[0]);
  check(got === c[1], c[0] + ' -> ' + got + (got === c[1] ? '' : ' (expected ' + c[1] + ')'));
});

console.log('Lexicon file');
var t0 = Date.now();
var lex = new Greek.Lexicon(fs.readFileSync(path.join(root, 'greek', 'el_lexicon.txt'), 'utf8'));
check(lex.size > 100000, lex.size + ' sounds, ' + lex.nodes + ' trie nodes, read in ' + (Date.now() - t0) + ' ms');
function find(word) {
  var key = Greek.g2p(word), n = 0;
  for (var i = 0; i < key.length && n >= 0; i++) n = lex.child(n, Greek.PHONEMES.indexOf(key.charAt(i)));
  return n > 0 && lex.word[n] >= 0 ? lex.words[lex.word[n]] : null;
}
['καλησπέρα', 'υπολογιστής', 'Θεσσαλονίκη', 'πανεπιστήμιο'].forEach(function (w) {
  check(find(w) === w, w + ' is in the lexicon');
});
check(find('πολλή') === 'πολύ', 'words that sound alike share the more frequent spelling (πολλή -> ' + find('πολλή') + ')');

var CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'ref', 'greek.json'), 'utf8'));
console.log('Transcription (' + CASES.length + ' clips)');
var model = new Whistle.Model(fs.readFileSync(path.join(root, 'whistle.cact')));
model.greek = new Greek.Decoder(lex);
CASES.forEach(function (c) {
  var wav = cli.readWav(path.join(root, c.file)), pcm = cli.resample(wav.samples, wav.rate, 16000);
  t0 = Date.now();
  var r = model.transcribe(pcm, { language: 'el' });
  check(r.text === c.text && r.language === 'el', path.basename(c.file) + ': "' + r.text + '"' +
    (r.text === c.text ? '' : ' (expected "' + c.text + '")') + ', ' + (Date.now() - t0) + ' ms');
});

console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
process.exitCode = failed ? 1 : 0;
