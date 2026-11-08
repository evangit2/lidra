/**
 * Widevine licence endpoint probe.
 *
 * Runs the real licence exchange against Apple with a throwaway device, to prove
 * the request shape is accepted by the endpoint (transport, headers, challenge
 * encoding, pssh) and to record exactly how Apple answers a device it does not
 * recognise. It cannot return a content key — that needs an authorised CDM — but
 * a structured licence refusal instead of a schema error means the client side is
 * correct.
 *
 * Run with:  xvfb-run -a npx electron --no-sandbox test/e2e/widevine-probe.cjs [songId]
 */
const { app, BrowserWindow, session } = require("electron");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const root = path.dirname(path.dirname(__dirname));
const dist = path.join(root, "dist");

const { parseMasterPlaylist, parseMediaPlaylist, rankVariants } = require(
  path.join(dist, "audio", "hls.js"),
);
const { resolveSong, fetchText } = require(path.join(dist, "audio", "catalog.js"));
const { acquireContentKey } = require(path.join(dist, "audio", "widevine", "license.js"));
const { ProtoWriter } = require(path.join(dist, "audio", "widevine", "protobuf.js"));

app.setName("Lidra");
app.setPath("userData", path.join(os.homedir(), ".config", "Lidra"));

const songId = process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : "268443097";

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

/** A plausible ClientIdentification protobuf for a device Apple will not know. */
function clientId() {
  return new ProtoWriter()
    .varint(1, 1) // company_name
    .bytes(2, Buffer.from("Lidra", "utf8")) // model_name
    .bytes(3, Buffer.from("lidra-probe", "utf8")) // device_name
    .bytes(4, crypto.randomBytes(16)) // device_id
    .finish();
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
  const variant = rankVariants(variants)[0];
  const media = parseMediaPlaylist(await fetchText(variant.uri), variant.uri);
  const keyUri = media.segments.find((segment) => segment.key?.uri)?.key?.uri;
  if (!keyUri) throw new Error("media playlist declared no key URI");

  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const device = {
    clientId: clientId(),
    privateKey,
    keyBits: 2048,
  };

  const result = {
    song: asset.name,
    rendition: variant.label,
    keyUriKind: keyUri.startsWith("skd://") ? "fairplay" : "widevine-pssh",
    keyUriPrefix: keyUri.slice(0, 48),
  };

  try {
    const key = await acquireContentKey({
      device,
      credentials: { developerToken, mediaUserToken },
      adamId: songId,
      keyUri,
    });
    result.outcome = "LICENCE GRANTED";
    result.keyLength = key.length;
  } catch (error) {
    result.outcome = "refused";
    result.errorName = error.name;
    result.message = error.message;
    result.status = error.status ?? null;
  }

  console.log("RESULT " + JSON.stringify(result, null, 2));
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  console.log("ERROR " + (error && error.stack ? error.stack : String(error)));
  app.exit(1);
});
