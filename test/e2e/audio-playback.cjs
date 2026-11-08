/**
 * End-to-end playback check for the Lidra audio path.
 *
 * Run with:  npx electron test/e2e/audio-playback.cjs
 *
 * It builds an ALAC/96 kHz sample with ffmpeg, muxes it through the real
 * transcoder into HLS/FLAC, serves that playlist from the real loopback server,
 * then plays it in this Chromium build through MediaSource and reports whether
 * the media element actually advances. This is the check that matters: it proves
 * the bytes Lidra produces are decodable by the player the page uses.
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.dirname(path.dirname(__dirname));
const dist = path.join(root, "dist");

const { createTranscoder, findFfmpeg } = require(path.join(dist, "audio", "transcode.js"));
const { HlsServer } = require(path.join(dist, "audio", "server.js"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "lidra-e2e-"));
const source = path.join(work, "source.mp4");
const outDir = path.join(work, "hls");

function buildSource(ffmpeg) {
  execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=96000:duration=6",
      "-af",
      "volume=0.2",
      "-ac",
      "2",
      "-c:a",
      "alac",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-y",
      source,
    ],
    { stdio: "inherit" },
  );
}

async function mux(ffmpeg) {
  const transcoder = createTranscoder({ outputDir: outDir, transform: "flac", ffmpegPath: ffmpeg });
  const bytes = fs.readFileSync(source);
  // Feed in 64 KiB chunks, the way decrypted fragments arrive.
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    await transcoder.write(bytes.subarray(offset, offset + 65536));
  }
  await transcoder.finish();
  return transcoder.playlistPath;
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<audio id="a" autoplay></audio>
<script>
  window.__result = { stage: "start" };
  const log = (stage, extra) => { window.__result = Object.assign({ stage }, extra || {}); };
  async function main() {
    const masterUrl = new URLSearchParams(location.search).get("master");
    const base = masterUrl.replace(/master\\.m3u8$/, "");
    const master = await (await fetch(masterUrl)).text();
    const mediaName = master.trim().split("\\n").filter((l) => l && !l.startsWith("#")).pop();
    const media = await (await fetch(new URL(mediaName, base))).text();
    const lines = media.trim().split("\\n");
    const init = lines.find((l) => l.startsWith("#EXT-X-MAP"))?.match(/URI="([^"]+)"/)?.[1];
    const segments = lines.filter((l) => l && !l.startsWith("#"));
    log("playlist", { media, init, segments });
    const mime = MediaSource.isTypeSupported('audio/mp4; codecs="flac"');
    log("caps", { mime, segments: segments.length });
    const mediaSource = new MediaSource();
    const audio = document.getElementById("a");
    audio.src = URL.createObjectURL(mediaSource);
    await new Promise((resolve) => mediaSource.addEventListener("sourceopen", resolve, { once: true }));
    const buffer = mediaSource.addSourceBuffer('audio/mp4; codecs="flac"');
    const append = (bytes) => new Promise((resolve, reject) => {
      buffer.addEventListener("updateend", resolve, { once: true });
      buffer.addEventListener("error", () => reject(new Error("append failed")), { once: true });
      buffer.appendBuffer(bytes);
    });
    await append(await (await fetch(new URL(init, base))).arrayBuffer());
    for (const segment of segments) {
      await append(await (await fetch(new URL(segment, base))).arrayBuffer());
      if (mediaSource.readyState === "open") mediaSource.endOfStream();
      break;
    }
    audio.play().catch((error) => log("play-rejected", { error: String(error) }));
    log("appended", { segments: segments.length });
  }
  window.__probe = () => {
    const audio = document.getElementById("a");
    return Object.assign({}, window.__result, {
      currentTime: audio.currentTime,
      duration: audio.duration,
      paused: audio.paused,
      readyState: audio.readyState,
      error: audio.error ? audio.error.code : null,
    });
  };
  main().catch((error) => log("error", { error: String(error) }));
</script>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) throw new Error("ffmpeg not found");
    buildSource(ffmpeg);
    const playlist = await mux(ffmpeg);
    if (!fs.existsSync(playlist)) throw new Error("transcoder produced no playlist");

    const server = new HlsServer({
      resolveTrack: () =>
        fs.existsSync(path.join(outDir, "playlist.m3u8"))
          ? { directory: outDir, codecs: "flac", bandwidth: 900000, complete: true }
          : null,
    });
    await server.start();

    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}?master=${encodeURIComponent(server.masterUrl("e2e"))}`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const result = await win.webContents.executeJavaScript("window.__probe()");
    console.log("RESULT " + JSON.stringify(result, null, 2));

    const advanced = typeof result.currentTime === "number" && result.currentTime > 0.2;
    const decoded = result.readyState >= 2 && result.error === null;
    if (!advanced || !decoded) {
      console.error("FAIL: media did not decode and advance");
      exitCode = 1;
    } else {
      console.log(`OK: FLAC HLS playback advanced to ${result.currentTime.toFixed(2)}s`);
    }
    await server.stop();
  } catch (error) {
    console.error("FAIL:", error && error.stack ? error.stack : String(error));
    exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
