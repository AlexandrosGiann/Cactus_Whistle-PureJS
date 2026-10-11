# Whistle in pure JavaScript

A dependency-free JavaScript runtime for [Cactus Whistle](https://huggingface.co/Cactus-Compute/whistle),
the 16.9 MB speech-to-text model. No WASM, no native addon, no server-side inference: `whistle.js`
reads the official `whistle.cact` archive and runs the whole pipeline in a browser tab or in Node.

It produces the same transcripts as the official engine on the test clips here
(see [Verification](#verification)).

## Run it

```bash
node serve.js
```

Then open <http://localhost:8766/>. The page downloads `whistle.cact` from the same folder, and you can
record from the microphone, choose an audio file, or try the bundled sample clip. The page has to be
served over HTTP: browsers block `fetch`, workers and the microphone on `file://`.

### On a phone (same Wi-Fi)

Browsers allow the microphone only on `https://` (or `localhost`), so a phone needs the HTTPS address.
On the computer that holds this folder (Node 16 or newer, nothing else to install):

```bash
node serve.js --lan
```

It detects the computer's network address and prints three lines per address, for example:

```
Page (microphone works):   https://192.168.1.50:8443/
Certificate for the phone: http://192.168.1.50:8766/ca.crt
Plain HTTP (no microphone): http://192.168.1.50:8766/
```

Use the addresses your own run prints. The first run creates a private certificate authority in
`.cert/`; the phone has to trust it once:

1. On the phone, open the `http://.../ca.crt` address in Chrome and download the file.
2. Open **Settings → Security & privacy → More security settings → Encryption & credentials →
   Install a certificate → CA certificate** (on some phones: Settings → Security → Install from
   storage; searching Settings for "CA certificate" finds it). Confirm the warning and pick
   `whistle-demo-ca.crt`. Android asks for a screen lock if none is set.
3. Open the `https://...:8443/` address in Chrome. Allow the microphone when asked.

The certificate authority is reused on later runs, and the server certificate is renewed by itself
when the computer's address changes, so the phone is set up only once per computer.
If the phone cannot connect at all, allow Node through the computer's firewall for private networks
and check that both devices are on the same network (not a guest Wi-Fi with client isolation).

Without installing anything, there are two alternatives: on Chrome's warning page for the
`https://` address choose **Advanced → Proceed**, or open `chrome://flags`, search for
"Insecure origins treated as secure", add the plain `http://...:8766` address, enable and relaunch.

`.cert/` holds private keys: it is in `.gitignore`, the server refuses to serve it, and it should
never be shared. Anyone holding `.cert/ca.key.pem` could impersonate sites to a phone that trusts
this authority, so remove the certificate from the phone (Settings → Encryption & credentials →
User credentials / Trusted credentials → User) when you are done testing.

The server only delivers files. The model still runs entirely in the phone's browser, in plain
JavaScript. "Try the sample clip" uses `whistle_recording_16k.wav` and falls back to
`test/audio/jfk.wav`, so at least one of the two must be in the folder being served.

### Microphone on older Android browsers

Recording used to end with "The recording is too short" on an older Android phone. The page created
its audio context only after the permission prompt had been answered, which is outside the tap, and
mobile Chrome keeps such a context suspended: no audio callbacks ever ran, so nothing was captured.
`recorder.js` now:

- creates and resumes the audio context inside the tap itself, resumes it again once the microphone
  is granted, and once more if no audio has arrived after 1.2 s;
- captures raw PCM with `getUserMedia` + `ScriptProcessor` as before, and runs a `MediaRecorder`
  beside it where one exists; the recorded blob is decoded and used only when the PCM path delivered
  nothing or far less than the elapsed time;
- retries with plain `{ audio: true }` when the browser rejects the detailed constraints, and falls
  back to the prefixed callback `getUserMedia` on browsers without `navigator.mediaDevices`;
- ignores a second tap within 350 ms of the first (a double-fired tap would start and stop at once)
  and taps made while the permission prompt is open;
- stops cleanly when the microphone track ends by itself, keeping what was captured;
- reports what actually happened: permission denied, no microphone, only silence delivered, or no
  audio arrived, instead of one generic message.

**Microphone diagnostics**, under the Audio buttons, lists what the browser offers (browser and
Android version, secure context, permission state, supported constraints, `MediaRecorder` and its
formats) and, for every recording, the audio context state and sample rate, the track state and
settings, the number of audio callbacks and PCM samples, peak and RMS level, the `MediaRecorder`
blob type and size, and the peak and RMS of the decoded audio. "Copy log" puts it on the clipboard.

#### When the browser delivers silence

On a Lenovo A2020a40 (Android 5.1) with Firefox, the microphone indicator is on, yet the audio
context reports `running` with zero `ScriptProcessor` callbacks, and `MediaRecorder` produces about
3 KB of Opus for 5 s, which decodes to silence. Both capture paths are starved inside the browser,
so no single known fix applies. Two things changed:

- A capture that decodes to silence is now reported as "the browser delivered only silence"
  instead of being sent to the model and coming back as "(no speech detected)".
- **Run microphone test** records 2.5 s with each of five capture setups while you keep talking,
  prints one line per setup (callbacks, PCM peak and RMS, recorder bytes, decoded peak and RMS),
  and selects the first one that carries sound. The choice is remembered in that browser and can
  be changed by hand in the **Setup** list.

| setup | what it changes |
|---|---|
| `raw` (default) | echo cancellation, noise suppression and gain control off; audio context opened in the tap |
| `plain` | the browser's default constraints (`audio: true`) |
| `plain-late` | default constraints, audio context opened after the stream, processor wired straight to the output |
| `voice-late` | voice processing explicitly on, otherwise as `plain-late` |
| `recorder-only` | no Web Audio while recording; `MediaRecorder` alone, decoded afterwards |

Whether any of them works on that phone is not known: it has to be run there. If the test reports
that no setup delivers sound, the browser itself is not passing microphone audio to web pages on
that device, and the page cannot work around it; recording with another app and using
"Choose audio file" keeps working.

`node test/test_recorder.js` exercises these paths with stand-in browser objects.

### AMR files from phone voice recorders

Browsers do not decode AMR, so `.amr` recordings (AMR-NB, the 8 kHz format of Android voice
recorders) go through a bundled decoder: `vendor/amrnb.js`, which is
[opencore-amr](https://sourceforge.net/projects/opencore-amr/) compiled to asm.js by the
[opencore-amr-js](https://github.com/yxl/opencore-amr-js) project (Apache-2.0, commit `dcf3d2b`,
unmodified). asm.js is ordinary JavaScript, so this adds no WebAssembly. The page fetches the
decoder (0.5 MB) only when an AMR file is chosen, and the audio is resampled from 8 to 16 kHz for
the model. The command line reads `.amr` too.

AMR-WB (`#!AMR-WB` files) and AMR inside a `.3gp` container are not supported.

From the command line:

```bash
node whistle_cli.js whistle_recording_16k.wav
node whistle_cli.js test/audio/jfk.amr
```

Options: `--language en|de|fr|es|it|nl|pl` (default: detect), `--greedy` (one beam, faster),
`--json`, `--model path/to/whistle.cact`.

## Use it from code

```js
// Node
const Whistle = require('./whistle.js');
const model = new Whistle.Model(fs.readFileSync('whistle.cact'));
const result = model.transcribe(pcm);            // Float32Array, 16 kHz mono, [-1, 1]
console.log(result.text, result.language);
```

```html
<!-- Browser -->
<script src="whistle.js"></script>
<script>
  const model = new Whistle.Model(await (await fetch('whistle.cact')).arrayBuffer());
  const { text } = model.transcribe(pcm, { language: 'en' });
</script>
```

`transcribe(pcm, options)` returns `{ text, language, tokens, silent, timings }`. Options:

| option | meaning |
|---|---|
| `language` | `'en'`, `'de'`, `'fr'`, `'es'`, `'it'`, `'nl'`, `'pl'`; omit to detect |
| `beams` | beam width, default 5 (the engine's); 1 is greedy |
| `onProgress(stage, fraction)` | `'frontend'`, `'stem'`, `'encoder'`, `'decoder'` |
| `onStep(step, partialText)` | called after every decoding step |

`model.embed(pcm)` returns the encoder output, one row of 512 floats per 80 ms frame.
Inference is synchronous and takes seconds, so in a page run it in a worker; `whistle_worker.js` does that.

## Files

| file | role |
|---|---|
| `whistle.js` | the runtime: `.cact` reader, front end, stem, encoder, decoder, beam search, detokeniser |
| `whistle_worker.js` | Web Worker wrapper used by the page |
| `index.html`, `app.js` | the demo page: model download, file input, progress |
| `recorder.js` | microphone capture: raw PCM through Web Audio, MediaRecorder as backup, diagnostics |
| `serve.js` | static file server for the page; `--lan` adds HTTPS for phones |
| `whistle_cli.js` | command line front end, WAV and AMR readers, resampler |
| `vendor/amrnb.js` | third-party AMR-NB decoder (opencore-amr as asm.js), with its licence and notice beside it |
| `test/test.js` | regression test against stored reference outputs |
| `test/test_recorder.js` | microphone capture logic against stand-in browser objects |
| `test/reference_wasm.js` | side-by-side comparison with the official `needle.wasm` (development only) |
| `whistle.cact` | the model, unchanged from Hugging Face |

`whistle.safetensors` (the 220 MB float checkpoint) is not used at run time.
`whistle_cact.js`, `browser_cact.js` and `browser_mic.js` are from the earlier attempt and are no longer
referenced; they can be deleted.

## Verification

```bash
node test/test.js
```

checks transcripts, language detection, silence handling and the encoder output against references
produced by the official engine. To compare against the engine directly, download `needle.js` and
`needle.wasm` from <https://huggingface.co/Cactus-Compute/needle3/tree/main/wasm> into a folder and run

```bash
node test/reference_wasm.js path/to/wasm test/audio/jfk.wav whistle_recording_16k.wav
```

Measured on this machine (Node 24, one thread):

| clip | official wasm engine | whistle.js | encoder cosine | transcript |
|---|---|---|---|---|
| `whistle_recording_16k.wav`, 3.0 s | 0.5 s | 1.5 s | 0.99994 | identical |
| `test/audio/jfk.wav`, 11.0 s | 1.6 s | 5 to 6 s | 0.99985 | identical |
| the two joined, 14.5 s | 2.2 s | 6.9 s | 0.99991 | identical |

The outputs are not bit-identical and cannot be: every matmul input is rounded to int8, so a
last-digit difference in float summation order flips a rounding now and then. The official engine's
own native and wasm builds differ from each other by the same amount. On hard audio (for example
English speech decoded with a forced German language token) that noise can tip a close beam decision.

## What is implemented

- **Front end**: loudness normalisation (99th percentile of 20 ms block RMS mapped to 0.1), 25 ms
  symmetric Hann window, 10 ms hop, zero-padded centred frames, 512-point FFT power spectrum, the
  archive's 80-bin mel filterbank, `log(mel + 2^-24)`, then per-channel mean and variance
  normalisation over the clip.
- **Silence gate**: the clip is skipped when the 99th minus 10th percentile of the 250 to 3500 Hz
  frame loudness is under 5 dB.
- **Stem**: three 3x3 stride-2 convolutions (the second and third depthwise plus a quantised pointwise),
  SiLU, then a projection of the 10 x 128 remaining frequency-channels to width 512.
- **Encoder**, 8 blocks on 4 residual lanes (mHC): half-step Hadamard MLP, non-causal GQA attention
  with RoPE, a convolution module (pointwise to 1024, GLU, 9-tap depthwise over time, norm, SiLU,
  pointwise), and a second half-step Hadamard MLP.
- **Decoder**, 8 blocks: causal GQA attention with 3 conv taps on Q, K and V, gated cross attention
  over the clip (keys carry a gated sinusoidal position signal), Hadamard MLP, engram lookups at
  layers 3 and 7, tied 4-bit embedding as the output head.
- **Numerics**: Cactus Quants weights are consumed as int8 centroids; each activation is
  Hadamard-rotated per group of 128 and quantised to int8 with one scale per group; Q, K, V and the
  engram values are quantised to int8 per head. Wide matmuls use per-activation lookup tables over the
  packed weight bytes, so the 2-bit matrices are never expanded in memory.
- **Search**: language token by argmax after BOS, then 5 beams with the 6 best continuations each,
  log-probabilities over the 8192 text pieces, stop after 5 finished hypotheses, pick the best
  length-normalised one, and end any hypothesis whose tail repeats four times.

## Not implemented

- Word timestamps and per-word probabilities.
- Keyword biasing.
- Live streaming (`needle_stream_transcribe_*`).
- The engine's sentence-aware cut for audio over 30 s. Longer clips are split at the quietest point
  in the last five seconds of each 30 s window instead, so transcripts of long audio can differ from
  the engine's around the cuts.
- The decoder ladder (`--audio-depth`): all 8 decoder layers always run.

## Speed

Roughly half of real time for 5-beam decoding on a current laptop, a third to a quarter of the
official SIMD wasm engine's speed. Greedy search (`beams: 1`) cuts decoding time about four-fold and the total by roughly 40%.
The encoder's attention grows with the square of the clip length, so a 30 s clip costs more than
three 10 s clips.
