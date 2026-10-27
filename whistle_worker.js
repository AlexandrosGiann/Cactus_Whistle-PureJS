/* Web Worker around whistle.js: keeps the page responsive while the model runs. */
'use strict';

importScripts('whistle.js');

var model = null;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

// Greek is fetched the first time it is asked for: greek.js and its 7 MB word list.
function loadGreek(id) {
  post({ type: 'progress', id: id, stage: 'lexicon', fraction: 0 });
  importScripts('greek.js');
  var x = new XMLHttpRequest();
  x.open('GET', 'greek/el_lexicon.txt', false);            // a synchronous request is allowed in a worker
  x.send();
  if (x.status !== 200) throw new Error('greek/el_lexicon.txt could not be loaded (HTTP ' + x.status + ')');
  model.greek = new WhistleGreek.Decoder(new WhistleGreek.Lexicon(x.responseText));
}

self.onmessage = function (ev) {
  var m = ev.data;
  try {
    if (m.type === 'load') {
      var t0 = performance.now();
      model = new Whistle.Model(m.buffer);
      post({
        type: 'loaded', ms: performance.now() - t0, tensors: model.cact.numTensors,
        bytes: m.buffer.byteLength, languages: model.languages, config: model.cfg
      });
    } else if (m.type === 'transcribe') {
      if (!model) throw new Error('model is not loaded');
      if (m.language === 'el' && !model.greek) loadGreek(m.id);
      var last = 0;
      var r = model.transcribe(m.pcm, {
        language: m.language || null,
        beams: m.beams || 5,
        onProgress: function (stage, fraction, overall) {
          var now = performance.now();
          if (stage === 'encoder' && fraction < 1 && now - last < 60) return;
          last = now;
          post({ type: 'progress', id: m.id, stage: stage, fraction: fraction, overall: overall });
        },
        onStep: function (step, text) { post({ type: 'partial', id: m.id, step: step, text: text }); },
        onWindow: function (text, done) { post({ type: 'window', id: m.id, text: text, done: done }); }
      });
      post({
        type: 'result', id: m.id, text: r.text, language: r.language, silent: r.silent,
        tokens: r.tokens.length, timings: r.timings, seconds: m.pcm.length / 16000
      });
    }
  } catch (e) {
    post({ type: 'error', id: m.id, message: String(e && e.message || e) });
  }
};
