/**
 * End-to-end proof with a real CDM: licence, decrypt, decode.
 *
 * Uses the reference archive's Widevine L3 device (client_id.bin + private_key.pem)
 * to run the actual licence exchange, then streams the track through the shipping
 * TrackPipeline — decrypt, transcode, write to disk — and reports what landed.
 *
 * Run: LIDRA_WIDEVINE_DEVICE=~/.lidra-cdm xvfb-run -a npx electron --no-sandbox \
 *        test/e2e/widevine-real.cjs [songId]
 */
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.dirname(path.dirname(__dirname));
const dist = path.join(root, "dist");

const { resolveSong } = require(path.join(dist, "audio", "catalog.js"));
const { KeyCache } = require(path.join(dist, "audio", "keys.js"));
const { createWidevineProvider } = require(path.join(dist, "audio", "widevine", "provider.js"));
const { TrackPipeline } = require(path.join(dist, "audio", "pipeline.js"));
const { webPlaybackMaster } = require(path.join(dist, "audio", "webplayback.js"));
const { parseInit } = require(path.join(dist, "audio", "mp4", "init.js"));

app.setName("Lidra");
app.setPath("userData", path.join(os.homedir(), ".config", "Lidra"));

const songId = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : "268443097";
const deviceSpec = process.env.LIDRA_WIDEVINE_DEVICE || path.join(os.homedir(), ".lidra-cdm");
const cacheRoot = "/tmp/lidra-real";

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

async function main() {
  const ses = session.fromPartition("persist:lidra");
  const credentials = { developerToken: null, mediaUserToken: null };
  ses.webRequest.onBeforeSendHeaders({ urls: ["https://*.music.apple.com/*"] }, (details, callback) => {
    if (/^https:\/\/(amp-)?api\.music\.apple\.com\//.test(details.url)) {
      const auth = headerValue(details.requestHeaders, "Authorization");
      if (auth && auth.startsWith("Bearer ")) credentials.developerToken = auth.slice(7);
      const mut = headerValue(details.requestHeaders, "Media-User-Token");
      if (mut) credentials.mediaUserToken = mut;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await win.loadURL("https://music.apple.com/us/search?term=miles%20davis");
  for (let i = 0; i < 15 && !(credentials.developerToken && credentials.mediaUserToken); i += 1) {
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!credentials.developerToken || !credentials.mediaUserToken) throw new Error("no session tokens");
  console.log("SESSION ok");

  const provider = createWidevineProvider(deviceSpec, () => credentials);
  if (!provider) throw new Error(`device rejected: ${deviceSpec}`);
  console.log("DEVICE loaded from " + deviceSpec);

  const asset = await resolveSong(songId, "us", credentials);
  console.log(`ASSET ${asset.id} "${asset.name}" — ${asset.artistName}`);

  fs.rmSync(cacheRoot, { recursive: true, force: true });
  const pipeline = new TrackPipeline({
    asset,
    preference: null,
    keyCache: new KeyCache(provider),
    cacheRoot,
    ffmpegPath: require("ffmpeg-static"),
    spatial: "bed",
    webPlayback: (adamId) => webPlaybackMaster(adamId, credentials),
  });

  const prepared = await pipeline.prepare();
  const facts = pipeline.snapshot().facts;
  console.log(`VARIANT ${prepared.variant.label} — ${prepared.variant.codecs} ` +
    `${prepared.variant.sampleRate ?? "?"}Hz/${prepared.variant.bitDepth ?? "?"}bit ` +
    `${prepared.variant.bitrateKbps ?? "?"}kbps`);
  console.log(`FACTS ${JSON.stringify(facts)}`);

  await pipeline.drain();
  const snap = pipeline.snapshot();
  console.log(`DRAIN state=${snap.state} bytesIn=${snap.bytesIn} error=${snap.error ?? "none"}`);

  const dir = pipeline.directory;
  const files = fs.readdirSync(dir).sort();
  console.log(`FILES ${files.length}: ${files.slice(0, 6).join(", ")}${files.length > 6 ? " …" : ""}`);
  const init = path.join(dir, "init.mp4");
  if (fs.existsSync(init)) {
    const info = parseInit(fs.readFileSync(init));
    console.log(`INIT track=${JSON.stringify(info.trackId ?? null)} ok`);
  }
  app.exit(snap.state === "complete" ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.log("ERR " + (error && error.stack ? error.stack : error));
  app.exit(1);
});
