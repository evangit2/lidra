/**
 * Web-playback asset lookup.
 *
 * The catalogue's `enhancedHls` master offers ALAC and Atmos, but every one of
 * those renditions is FairPlay (`skd://`) — no CDM can decrypt them. Apple's
 * older `webPlayback` endpoint still serves one rendition keyed with Widevine:
 * flavour `28:ctrp256` (AAC 256), which a Widevine device *can* open.
 *
 * So when the pipeline is configured with a Widevine device and the chosen
 * rendition turns out to be FairPlay-only, it falls back to this asset. That is
 * 256 kbps, not lossless — the honest ceiling of the key system Apple exposes
 * to a web session.
 */
import log from "electron-log/main";

const webLog = log.scope("audio.webplayback");

const WEB_PLAYBACK_ENDPOINT =
  "https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback";

/** Flavour keyed with Widevine; every other flavour comes back FairPlay. */
const WIDEVINE_FLAVOUR = "28:ctrp256";

const REQUEST_TIMEOUT_MS = 15_000;

export interface WebPlaybackCredentials {
  developerToken: string;
  mediaUserToken: string;
}

export interface WebPlaybackMaster {
  /** A synthetic master playlist naming the Widevine-keyed rendition. */
  text: string;
  /** Base URL for resolving the rendition; also the manifest's own URL. */
  baseUrl: string;
  /** Declared bitrate of the asset, in kbps, when Apple reports one. */
  bitrateKbps?: number;
}

interface WebPlaybackResponse {
  songList?: Array<{
    assets?: Array<{ flavor?: string; URL?: string }>;
  }>;
  failureType?: string;
  customerMessage?: string;
}

/** Build the master playlist text the parser expects around a media playlist. */
export function masterForMedia(uri: string, bitrateKbps: number, codecs = "mp4a.40.2"): string {
  return [
    "#EXTM3U",
    `#EXT-X-STREAM-INF:BANDWIDTH=${bitrateKbps * 1000},CODECS="${codecs}"`,
    uri,
    "",
  ].join("\n");
}

/**
 * Ask Apple for the web-playback assets of a song and return the Widevine-keyed
 * one as a master playlist. Returns null when the account has no such asset.
 */
export async function webPlaybackMaster(
  adamId: string,
  credentials: WebPlaybackCredentials,
  fetchImpl: typeof fetch = fetch,
  endpoint: string = WEB_PLAYBACK_ENDPOINT,
): Promise<WebPlaybackMaster | null> {
  if (!credentials.developerToken || !credentials.mediaUserToken) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://music.apple.com",
        referer: "https://music.apple.com/",
        authorization: `Bearer ${credentials.developerToken}`,
        "x-apple-music-user-token": credentials.mediaUserToken,
      },
      body: JSON.stringify({ salableAdamId: adamId }),
      signal: controller.signal,
    });
  } catch (error) {
    webLog.warn(
      `web playback lookup failed for ${adamId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    webLog.warn(`web playback returned ${response.status} for ${adamId}`);
    return null;
  }

  let payload: WebPlaybackResponse;
  try {
    payload = (await response.json()) as WebPlaybackResponse;
  } catch (error) {
    webLog.warn(
      `web playback returned non-JSON for ${adamId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  if (!payload.songList?.length) {
    webLog.info(
      `no web playback asset for ${adamId}${payload.customerMessage ? ` (${payload.customerMessage})` : ""}`,
    );
    return null;
  }

  const assets = payload.songList[0]?.assets ?? [];
  const asset = assets.find((entry) => entry.flavor === WIDEVINE_FLAVOUR && entry.URL);
  if (!asset?.URL) {
    webLog.info(
      `web playback offered no Widevine rendition for ${adamId} (flavours: ${assets
        .map((entry) => entry.flavor)
        .filter(Boolean)
        .join(", ")})`,
    );
    return null;
  }

  webLog.info(`using the Widevine web-playback rendition for ${adamId}`);
  return { text: masterForMedia(asset.URL, 256), baseUrl: asset.URL, bitrateKbps: 256 };
}
