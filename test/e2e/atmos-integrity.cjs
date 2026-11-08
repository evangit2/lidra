/**
 * Atmos delivery integrity check.
 *
 * Answers "does the Atmos stream arrive clean?" without keys, by validating the
 * container itself: the init segment's encryption parameters and Dolby
 * configuration, then every sample's offset, size, IV and subsample split in the
 * first segments of the real CDN stream.
 *
 * Run with:  xvfb-run -a npx electron --no-sandbox test/e2e/atmos-integrity.cjs
 */
const { app, BrowserWindow, session } = require("electron");
const os = require("node:os");
const path = require("node:path");

const root = path.dirname(path.dirname(__dirname));
const dist = path.join(root, "dist");

const { parseMasterPlaylist, parseMediaPlaylist, rankVariants, rangeHeader } = require(
  path.join(dist, "audio", "hls.js"),
);
const { resolveSong, fetchText, fetchStream } = require(path.join(dist, "audio", "catalog.js"));
const { parseInit } = require(path.join(dist, "audio", "mp4", "init.js"));
const { parseSegment } = require(path.join(dist, "audio", "mp4", "segment.js"));
const { inspectInitSegment } = require(path.join(dist, "audio", "quality.js"));

app.setName("Lidra");
app.setPath("userData", path.join(os.homedir(), ".config", "Lidra"));

const songId = process.env.SONG || "268443097";
const SEGMENTS = Number(process.env.SEGMENTS || 3);

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

async function main() {
  const ses = session.fromPartition("persist:lidra");
  let developerToken = null;
  let mediaUserToken = null;
  ses.webRequest.onBeforeSendHeaders(
    { urls: ["https://*.music.apple.com/*"] },
    (details, callback) => {
      if (!/^https:\/\/(amp-)?api\.music\.apple\.com\//.test(details.url)) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      const auth = headerValue(details.requestHeaders, "Authorization");
      if (auth && auth.startsWith("Bearer ")) developerToken = auth.slice(7);
      const mut = headerValue(details.requestHeaders, "Media-User-Token");
      if (mut) mediaUserToken = mut;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await win.loadURL("https://music.apple.com/us/search?term=miles%20davis");
  for (let attempt = 0; attempt < 15 && (!developerToken || !mediaUserToken); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  if (!developerToken || !mediaUserToken) throw new Error("no session tokens captured");

  const asset = await resolveSong(songId, "us", { developerToken, mediaUserToken });
  const variants = parseMasterPlaylist(await fetchText(asset.manifestUrl), asset.manifestUrl);
  const atmos = rankVariants(variants).filter((variant) => variant.tier === "atmos");
  if (atmos.length === 0) throw new Error("no Atmos rendition offered for this song");

  const report = { song: asset.name, atmosRenditions: [] };

  for (const variant of atmos) {
    const media = parseMediaPlaylist(await fetchText(variant.uri), variant.uri);
    const initResponse = await fetchStream(media.map.uri, {
      range: media.map.byterange ? rangeHeader(media.map.byterange) : undefined,
    });
    const init = Buffer.from(await initResponse.arrayBuffer());

    globalThis.__lastInit = init;
    const facts = inspectInitSegment(init);
    const parsed = parseInit(init);

    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });

    add(
      "init is Dolby E-AC-3",
      facts.codec === "ec-3",
      `${facts.label}`,
    );
    add(
      "manifest declares object audio",
      (variant.channels ?? "").toUpperCase().includes("JOC"),
      `CHANNELS="${variant.channels ?? "?"}"`,
    );
    add(
      "encryption is CBCS pattern",
      parsed.encryption.scheme === "cbcs",
      `scheme=${parsed.encryption.scheme} pattern=${parsed.encryption.cryptByteBlock}:${parsed.encryption.skipByteBlock}`,
    );
    add(
      "per-sample IV size is 0 (constant IV)",
      parsed.encryption.perSampleIvSize === 0,
      `perSampleIvSize=${parsed.encryption.perSampleIvSize}, constantIv=${parsed.encryption.constantIv?.length ?? 0} bytes`,
    );
    add(
      "KID present in tenc",
      Boolean(parsed.encryption.defaultKid && parsed.encryption.defaultKid.length === 16),
      parsed.encryption.defaultKid ? parsed.encryption.defaultKid.toString("hex") : "missing",
    );

    let totalSamples = 0;
    let totalBytes = 0;
    let totalSeconds = 0;

    for (let index = 0; index < Math.min(SEGMENTS, media.segments.length); index += 1) {
      const segment = media.segments[index];
      const response = await fetchStream(segment.uri, {
        range: segment.byterange ? rangeHeader(segment.byterange) : undefined,
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const { samples } = parseSegment(bytes);

      let inBounds = true;
      let monotonic = true;
      let lastEnd = 0;
      let subsamplesMatch = true;
      let ivsPresent = true;

      for (const sample of samples) {
        if (sample.offset < 0 || sample.offset + sample.size > bytes.length) inBounds = false;
        if (sample.offset < lastEnd) monotonic = false;
        lastEnd = sample.offset + sample.size;
        if (sample.subsamples) {
          const total = sample.subsamples.reduce(
            (sum, part) => sum + part.clear + part.encrypted,
            0,
          );
          if (total !== sample.size) subsamplesMatch = false;
        } else if (parsed.encryption.perSampleIvSize === 0 && sample.size <= 0) {
          subsamplesMatch = false;
        }
        // With a constant IV the per-sample IV is absent by design.
        if (parsed.encryption.perSampleIvSize > 0 && !sample.iv) ivsPresent = false;
      }

      add(
        `segment ${index}: samples in bounds`,
        inBounds,
        `${samples.length} samples, ${bytes.length} bytes`,
      );
      add(`segment ${index}: sample offsets monotonic`, monotonic, `ends at ${lastEnd}`);
      add(
        `segment ${index}: subsample splits add up`,
        subsamplesMatch,
        samples[0]?.subsamples
          ? `first sample clear=${samples[0].subsamples[0].clear} encrypted=${samples[0].subsamples[0].encrypted}`
          : "no subsamples",
      );
      if (parsed.encryption.perSampleIvSize > 0) {
        add(`segment ${index}: every sample carries an IV`, ivsPresent, "");
      }

      totalSamples += samples.length;
      totalBytes += bytes.length;
      totalSeconds += segment.duration ?? 0;
    }

    report.atmosRenditions.push({
      group: variant.audioGroup,
      declared: variant.label,
      measured: facts.label,
      sampleRate: facts.sampleRate,
      channels: facts.channels,
      bitrateKbps: facts.bitrateKbps,
      segmentsChecked: Math.min(SEGMENTS, media.segments.length),
      totalSamples,
      totalBytes,
      totalSeconds: Number(totalSeconds.toFixed(2)),
      pass: checks.every((check) => check.ok),
      failures: checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`),
      checks,
    });
  }

  if (process.env.DUMP_INIT) {
    const fs = require("node:fs");
    const dumpPath = process.env.DUMP_INIT === "1" ? "/tmp/atmos-init.bin" : process.env.DUMP_INIT;
    fs.writeFileSync(dumpPath, globalThis.__lastInit);
  }
  console.log("RESULT " + JSON.stringify(report, null, 2));
  app.exit(report.atmosRenditions.every((entry) => entry.pass) ? 0 : 1);
}

app.whenReady().then(main).catch((error) => {
  console.log("ERROR " + (error && error.stack ? error.stack : String(error)));
  app.exit(1);
});
