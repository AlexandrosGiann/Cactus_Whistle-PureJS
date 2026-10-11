#!/usr/bin/env node
/* Minimal static file server for the demo page: node serve.js [port] */
'use strict';

var http = require('http'), fs = require('fs'), path = require('path');

var root = __dirname, port = +process.argv[2] || +process.env.PORT || 8766;
var types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav',
  '.cact': 'application/octet-stream', '.md': 'text/plain; charset=utf-8'
};

http.createServer(function (req, res) {
  var rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  var file = path.join(root, path.normalize(rel));
  if (file.indexOf(root) !== 0) { res.writeHead(403); res.end(); return; }
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, '127.0.0.1', function () {
  console.log('Whistle demo: http://localhost:' + port + '/');
});
