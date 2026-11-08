/**
 * Live delivered-quality report.
 *
 * Run with:  xvfb-run -a npx electron test/e2e/quality-report.cjs "term" ["term"...]
 *
 * Uses the signed-in Lidra session (persist:lidra) to resolve real songs, then
 * downloads each chosen rendition's initialisation segment and reads the codec
 * configuration out of it. That is the only honest way to answer "is this
 * really the quality the manifest claims": the init segment is not encrypted and
 * it is what the decoder will actually be configured with.
 *
 * Writes one JSON object per song to stdout, prefixed with `REPORT `.
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
const { inspectInitSegment, verifyAgainstVariant } = require(path.join(dist, "audio", "quality.js"));

app.setName("Lidra");
app.setPath("userData", path.join(os.homedir(), ".config", "Lidra"));

const terms = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("-") && !arg.endsWith(".cjs"));
if (terms.length === 0) terms.push("daft punk");

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  await win.loadURL("https://music.apple.com/us/browse");

  // The page only sends authorised requests once it has loaded catalog data, so
  // touch a search page to make it re-authenticate.
  for (let attempt = 0; attempt < 15 && (!developerToken || !mediaUserToken); attempt += 1) {
    await win.loadURL(`https://music.apple.com/us/search?term=${encodeURIComponent(terms[0])}`);
    await sleep(1500);
  }
  if (!developerToken || !mediaUserToken) {
    console.log("REPORT " + JSON.stringify({ error: "no session tokens captured — sign in first" }));
    app.exit(1);
    return;
  }
  console.log(
    "REPORT " + JSON.stringify({ status: "session", hasDevToken: true, hasMediaUserToken: true }),
  );

  const credentials = { developerToken: developerToken, mediaUserToken: mediaUserToken };
  const headers = {
    Authorization: `Bearer ${developerToken}`,
    "Media-User-Token": mediaUserToken,
    origin: "https://music.apple.com",
  };
  /** fetch with the session's auth headers attached. */
  const authed = (url, init = {}) =>
    fetch(url, { ...init, headers: { ...(init.headers || {}), ...headers } });

  // Search once per term, and keep the first song of each distinct tier.
  const seen = new Set();
  const songs = [];
  for (const term of terms) {
    const searchUrl =
      "https://amp-api.music.apple.com/v1/catalog/us/search?term=" +
      encodeURIComponent(term) +
      "&types=songs&limit=25";
    let payload;
    try {
      payload = JSON.parse(await fetchText(searchUrl, authed));
    } catch (error) {
      console.log("REPORT " + JSON.stringify({ term, error: String(error.message || error) }));
      continue;
    }
    for (const item of payload?.results?.songs?.data ?? []) {
      if (!item?.id || !item?.attributes?.name) continue;
      songs.push({
        id: String(item.id),
        title: item.attributes.name,
        artist: item.attributes.artistName,
        album: item.attributes.albumName,
      });
    }
  }
  console.log("REPORT " + JSON.stringify({ status: "candidates", count: songs.length }));

  if (process.env.LIDRA_REPORT_IDS) {
    songs.length = 0;
    for (const id of process.env.LIDRA_REPORT_IDS.split(",")) {
      songs.push({ id: id.trim(), title: "?", artist: "?" });
    }
  }
  const maxSongs = Number(process.env.LIDRA_REPORT_MAX || 10);
  const report = [];
  for (const song of songs.slice(0, maxSongs)) {
    let asset;
    try {
      asset = await resolveSong(song.id, "us", credentials);
    } catch (reason) {
      console.log("REPORT " + JSON.stringify({ id: song.id, stage: "resolve", error: String(reason && reason.message ? reason.message : reason) }));
      continue;
    }
    if (!asset?.manifestUrl) {
      console.log("REPORT " + JSON.stringify({ id: song.id, stage: "resolve", error: "no enhancedHls" }));
      continue;
    }

    if (process.env.LIDRA_REPORT_TRAITS_ONLY) {
      let alacRates = [];
      try {
        const text = await fetchText(asset.manifestUrl);
        for (const match of text.matchAll(/GROUP-ID="audio-alac-stereo-(\d+)-(\d+)"/g)) {
          alacRates.push(Number(match[1]));
        }
      } catch {
        // traits still worth reporting
      }
      console.log("REPORT " + JSON.stringify({ id: song.id, song: `${song.artist} — ${song.title}`, traits: asset.audioTraits, alacRates }));
      if (process.env.LIDRA_STOP_ON_TRAIT && asset.audioTraits.includes(process.env.LIDRA_STOP_ON_TRAIT)) {
        console.log("REPORT " + JSON.stringify({ status: "found", id: song.id, trait: process.env.LIDRA_STOP_ON_TRAIT }));
        process.exitCode = 0;
        app.exit(0);
        return;
      }
      continue;
    }

    let variants;
    let masterText = "";
    try {
      masterText = await fetchText(asset.manifestUrl);
      variants = parseMasterPlaylist(masterText, asset.manifestUrl);
      if (process.env.LIDRA_DUMP_MASTER) {
        console.log("REPORT " + JSON.stringify({ id: song.id, manifest: asset.manifestUrl }));
        for (const line of masterText.split(/\r?\n/)) {
          if (/^#EXT-X-(MEDIA|STREAM-INF|SESSION)/.test(line)) console.log("MREPORT " + line);
        }
      }
    } catch (reason) {
      console.log("REPORT " + JSON.stringify({ id: song.id, stage: "master", url: asset.manifestUrl, error: String(reason && reason.message ? reason.message : reason) }));
      continue;
    }
    const ranked = rankVariants(variants);
    if (ranked.length === 0) continue;

    // One inspection per tier this song actually offers.
    for (const variant of ranked) {
      if (seen.has(`${song.id}:${variant.tier}`)) continue;
      if (variant.tier === "aac" && !process.env.LIDRA_REPORT_AAC) continue;
      seen.add(`${song.id}:${variant.tier}`);

      let facts = null;
      let check = null;
      let error = null;
      try {
        const media = parseMediaPlaylist(await fetchText(variant.uri), variant.uri);
        if (!media.map) throw new Error("media playlist has no EXT-X-MAP");
        const response = await fetchStream(
          media.map.uri,
          { range: media.map.range ? rangeHeader(media.map.range) : undefined },
          fetch,
        );
        const init = Buffer.from(await response.arrayBuffer());
        facts = inspectInitSegment(init);
        check = verifyAgainstVariant(variant, facts);
      } catch (reason) {
        error = String(reason && reason.message ? reason.message : reason);
      }

      const entry = {
        song: `${song.artist} — ${song.title}`,
        id: song.id,
        requested: variant.tier,
        traits: asset.audioTraits,
        declared: variant.label,
        declaredRate: variant.sampleRate ?? null,
        declaredDepth: variant.bitDepth ?? null,
        codecs: variant.codecs,
        actual: facts
          ? {
              codec: facts.codec,
              label: facts.label,
              sampleRate: facts.sampleRate,
              bitDepth: facts.bitDepth,
              channels: facts.channels,
              bitrateKbps: facts.bitrateKbps,
              atmos: facts.atmos,
              tier: facts.tier,
            }
          : null,
        verdict: check ? (check.ok ? "PASS" : "MISMATCH") : "ERROR",
        mismatches: check ? check.mismatches : [],
        error,
      };
      report.push(entry);
      console.log("REPORT " + JSON.stringify(entry));
    }
  }

  console.log("REPORT " + JSON.stringify({ status: "done", inspected: report.length }));
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  console.log("REPORT " + JSON.stringify({ error: String(error && error.stack ? error.stack : error) }));
  app.exit(1);
});
