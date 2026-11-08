/**
 * Multichannel Dolby -> FLAC playback test.
 *
 * Atmos is delivered as 5.1 E-AC-3, which Chromium cannot decode. Lidra
 * repackages it to multi-channel FLAC, and this proves end to end that the
 * browser actually decodes those bytes: it synthesises a 5.1 E-AC-3 source,
 * runs it through the same ffmpeg flags the pipeline uses, then feeds the
 * resulting HLS through Media Source Extensions and checks the clock advances.
 *
 * Run with:  xvfb-run -a npx electron --no-sandbox test/e2e/multichannel-playback.cjs
 */
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.dirname(path.dirname(__dirname));
const ffmpeg = require(path.join(root, "node_modules", "ffmpeg-static"));
const workDir = path.join(require("node:os").tmpdir(), "lidra-multichannel");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

function serve(directory) {
  const server = http.createServer((request, response) => {
    const name = path.basename(new URL(request.url, "http://localhost").pathname);
    const file = path.join(directory, name);
    if (!file.startsWith(directory) || !fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": name.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : name.endsWith(".html")
          ? "text/html; charset=utf-8"
          : "video/mp4",
      "access-control-allow-origin": "*",
    });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const PAGE = `<!doctype html>
<html><body style="background:#111;color:#eee;font:14px system-ui">
<audio id="a"></audio><pre id="out"></pre>
<script>
const out = (msg) => { const el = document.getElementById("out"); el.textContent += msg + "\\n"; };
const MIME = 'audio/mp4; codecs="flac"';
out("isTypeSupported(flac): " + MediaSource.isTypeSupported(MIME));

async function play(playlistUrl) {
  const text = await (await fetch(playlistUrl)).text();
  const base = playlistUrl.slice(0, playlistUrl.lastIndexOf("/") + 1);
  const lines = text.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
  let init = null;
  const segments = [];
  for (const line of lines) {
    const map = line.match(/#EXT-X-MAP:URI="([^"]+)"/);
    if (map) init = map[1];
    if (!line.startsWith("#")) segments.push(line);
  }
  out("segments: " + segments.length + " init: " + (init ?? "none"));

  const mediaSource = new MediaSource();
  const audio = document.getElementById("a");
  audio.src = URL.createObjectURL(mediaSource);
  await new Promise((resolve) => mediaSource.addEventListener("sourceopen", resolve, { once: true }));
  const buffer = mediaSource.addSourceBuffer(MIME);

  const append = (bytes) =>
    new Promise((resolve, reject) => {
      buffer.addEventListener("updateend", resolve, { once: true });
      buffer.addEventListener("error", reject, { once: true });
      buffer.appendBuffer(bytes);
    });

  const fetchBytes = async (url) => new Uint8Array(await (await fetch(base + url)).arrayBuffer());
  if (init) await append(await fetchBytes(init));
  for (const segment of segments.slice(0, 3)) await append(await fetchBytes(segment));

  const bufferedEnd = buffer.buffered.length ? buffer.buffered.end(0) : 0;
  out("buffer ranges: " + JSON.stringify(buffer.buffered.length ? [buffer.buffered.start(0), bufferedEnd] : []));

  // A headless machine has no audio sink, so wall-clock playback can stall even
  // though decoding works. Decoded-byte count is the honest signal that the
  // browser actually accepted and decoded 6-channel FLAC.
  try { await audio.play(); } catch (error) { out("play() rejected: " + error.message); }
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const decoded = audio.webkitAudioDecodedByteCount ?? 0;
  out("readyState: " + audio.readyState + " decodedBytes: " + decoded + " currentTime: " + audio.currentTime.toFixed(2));
  const ok = bufferedEnd >= 5.5 && (decoded > 0 || audio.currentTime > 0.2);
  out("RESULT " + (ok ? "PASS" : "FAIL"));
  document.title = ok ? "PASS" : "FAIL";
}
window.play = play;
</script></body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  // 5.1 E-AC-3 at 768 kbps, the shape of an Atmos bed.
  const source = path.join(workDir, "source.m4a");
  await run([
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "aevalsrc=0.08*sin(440*2*PI*t)|0.08*sin(554*2*PI*t)|0.08*sin(659*2*PI*t)|0.08*sin(880*2*PI*t)|0.08*sin(220*2*PI*t)|0.08*sin(330*2*PI*t):s=48000:c=5.1",
    "-t", "6", "-c:a", "eac3", "-b:a", "768k", "-f", "mp4", source,
  ]);

  // Same flags the pipeline uses for Dolby -> FLAC.
  await run([
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "mov", "-i", source,
    "-c:a", "flac", "-compression_level", "5", "-map", "0:a:0",
    "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "event",
    "-hls_segment_type", "fmp4", "-hls_flags", "independent_segments+temp_file",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", path.join(workDir, "seg%d.m4s"),
    path.join(workDir, "playlist.m3u8"),
  ]);

  fs.writeFileSync(path.join(workDir, "page.html"), PAGE);
  const { server, port } = await serve(workDir);
  const win = new BrowserWindow({ show: false, width: 700, height: 500 });
  await win.loadURL(`http://127.0.0.1:${port}/page.html`);
  const lines = [];
  win.webContents.on("console-message", (_event, _level, message) => lines.push(message));

  await win.webContents.executeJavaScript(`window.play("http://127.0.0.1:${port}/playlist.m3u8")`);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const text = await win.webContents.executeJavaScript("document.getElementById('out').textContent");
  process.stdout.write(text + "\n");
  const verdict = text.includes("RESULT PASS") ? 0 : 1;
  server.close();
  app.exit(verdict);
}).catch((error) => {
  process.stdout.write("ERROR " + (error && error.stack ? error.stack : String(error)) + "\n");
  app.exit(1);
});
