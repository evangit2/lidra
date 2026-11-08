/**
 * Live Apple Music probe for Lidra.
 *
 * Run with:  npx electron test/e2e/apple-probe.cjs [search term]
 *
 * Uses the Lidra session partition, so it sees exactly what the signed-in app
 * sees — no credentials are copied or printed. It reports, for real songs:
 *   - whether the catalog returns `enhancedHls` at all
 *   - every rendition the manifest lists, ranked the way Lidra ranks them
 *   - the chosen media playlist, its key URI and segment layout
 *   - whether the encrypted initialisation segment is actually reachable
 * Optionally it asks the configured key service for the first key, which proves
 * the decrypt path end to end without touching the audio.
 */
const { app, BrowserWindow, session } = require("electron");
const os = require("node:os");
const path = require("node:path");

const root = path.dirname(path.dirname(__dirname));
const dist = path.join(root, "dist");

const { parseMasterPlaylist, parseMediaPlaylist, rankVariants, selectVariant } = require(
  path.join(dist, "audio", "hls.js"),
);
const { resolveSong, fetchText, fetchStream } = require(path.join(dist, "audio", "catalog.js"));
const { KeyCache, createKeyProvider } = require(path.join(dist, "audio", "keys.js"));
const { rangeHeader } = require(path.join(dist, "audio", "hls.js"));

app.setName("Lidra");
app.setPath("userData", path.join(os.homedir(), ".config", "Lidra"));

const term = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "daft punk";

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
    { urls: ["https://api.music.apple.com/*"] },
    (details, callback) => {
      const auth = headerValue(details.requestHeaders, "Authorization");
      if (auth && auth.startsWith("Bearer ")) developerToken = auth.slice(7);
      const mut = headerValue(details.requestHeaders, "Media-User-Token");
      if (mut) mediaUserToken = mut;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  const cookies = await ses.cookies.get({ name: "media-user-token" });
  if (cookies.length > 0) mediaUserToken = cookies[0].value;

  const win = new BrowserWindow({ show: false, webPreferences: { partition: "persist:lidra" } });
  await win.loadURL("https://music.apple.com/us/browse");

  const deadline = Date.now() + 25000;
  while ((!developerToken || !mediaUserToken) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const report = {
    signedIn: Boolean(developerToken && mediaUserToken),
    developerToken: developerToken ? `present (${developerToken.length} chars)` : "missing",
    mediaUserToken: mediaUserToken ? `present (${mediaUserToken.length} chars)` : "missing",
  };
  console.log("SESSION " + JSON.stringify(report));

  if (!report.signedIn) {
    console.log("NOT_SIGNED_IN");
    return 2;
  }

  const credentials = { developerToken, mediaUserToken };
  const storefront = "us";

  const searchResponse = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/search?term=${encodeURIComponent(term)}&types=songs&limit=3`,
    {
      headers: {
        Authorization: `Bearer ${developerToken}`,
        "Media-User-Token": mediaUserToken,
        Origin: "https://music.apple.com",
      },
    },
  );
  const search = await searchResponse.json();
  const songs = search?.results?.songs?.data ?? [];
  console.log(`SEARCH ${songs.length} results for "${term}"`);
  if (songs.length === 0) {
    console.log("NO_RESULTS");
    return 3;
  }

  const keyProvider = createKeyProvider({
    transport: process.env.LIDRA_KEY_TRANSPORT === "http" ? "http" : "socket",
    address: process.env.LIDRA_KEY_SERVICE || "",
  });
  const keyCache = new KeyCache(keyProvider);

  for (const song of songs) {
    const id = song.id;
    const title = song.attributes?.name;
    const traits = song.attributes?.audioTraits ?? [];
    const entry = { id, title, traits };
    try {
      const asset = await resolveSong(id, storefront, credentials);
      entry.hasEnhancedHls = Boolean(asset.manifestUrl);
      const master = await fetchText(asset.manifestUrl);
      const variants = rankVariants(parseMasterPlaylist(master, asset.manifestUrl));
      entry.renditions = variants.map((variant) => ({
        tier: variant.tier,
        codecs: variant.codecs,
        label: variant.label,
        bandwidth: variant.bandwidth,
      }));

      const best = selectVariant(variants, null);
      if (best) {
        const media = parseMediaPlaylist(await fetchText(best.uri), best.uri);
        entry.chosen = {
          tier: best.tier,
          codecs: best.codecs,
          keyUri: media.segments[0]?.key?.uri ?? null,
          hasMap: Boolean(media.map),
          segments: media.segments.length,
          targetDuration: media.targetDuration,
          firstRange: media.segments[0]?.byterange ?? null,
        };

        if (media.map) {
          const initResponse = await fetchStream(media.map.uri, {
            range: media.map.byterange ? rangeHeader(media.map.byterange) : undefined,
          });
          const initBytes = Buffer.from(await initResponse.arrayBuffer());
          entry.initSegment = { bytes: initBytes.length, status: initResponse.status };
          try {
            const { parseInit } = require(path.join(dist, "audio", "mp4", "init.js"));
            const info = parseInit(initBytes);
            entry.encryption = {
              scheme: info.encryption.scheme,
              originalFormat: info.encryption.originalFormat,
              perSampleIvSize: info.encryption.perSampleIvSize,
              hasConstantIv: Boolean(info.encryption.constantIv),
              crypt: info.encryption.cryptByteBlock,
              skip: info.encryption.skipByteBlock,
            };
          } catch (error) {
            entry.encryption = { parseError: String(error) };
          }
        }

        if (media.segments[0]?.key?.uri) {
          try {
            const key = await keyCache.get({
              adamId: id,
              keyUri: media.segments[0].key.uri,
              storefront,
            });
            entry.keyService = `key acquired (${key.length} bytes)`;
          } catch (error) {
            entry.keyService = `key unavailable: ${String(error.message || error)}`;
          }
        }
      }
    } catch (error) {
      entry.error = String(error.message || error);
    }
    console.log("SONG " + JSON.stringify(entry, null, 2));
  }

  return 0;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (error) {
    console.error("PROBE_FAILED " + (error && error.stack ? error.stack : String(error)));
    code = 1;
  } finally {
    app.exit(code);
  }
});
