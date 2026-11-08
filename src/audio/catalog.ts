/**
 * Apple Music catalog access for Lidra.
 *
 * Lidra resolves a track's playable renditions through the public Apple Music
 * API using the credentials of the session the user already signed in with.
 * `extend=extendedAssetUrls` is what makes `enhancedHls` appear: that manifest
 * lists the lossless, hi-res and Dolby renditions that the web player's own
 * AAC-only manifest omits.
 */
import log from "electron-log/main";
import type { SessionCredentials } from "./tokens";

const catalogLog = log.scope("audio.catalog");

/** The web client's host; `api.music.apple.com` remains as a fallback. */
const API_ROOTS = ["https://amp-api.music.apple.com/v1", "https://api.music.apple.com/v1"];
const REQUEST_TIMEOUT_MS = 15_000;

export interface SongAsset {
  id: string;
  storefront: string;
  name: string;
  artistName: string;
  albumName: string;
  durationMs: number;
  isrc?: string;
  artworkUrl?: string;
  /** Master playlist listing every quality tier available for this song. */
  manifestUrl: string;
  /** Apple's quality traits, e.g. `lossless`, `hi-res-lossless`, `atmos`. */
  audioTraits: string[];
  contentRating?: string;
}

interface AppleArtwork {
  url?: string;
  width?: number;
  height?: number;
}

interface AppleSongAttributes {
  name?: string;
  artistName?: string;
  albumName?: string;
  durationInMillis?: number;
  isrc?: string;
  artwork?: AppleArtwork;
  audioTraits?: string[];
  contentRating?: string;
  extendedAssetUrls?: { enhancedHls?: string; plus?: string; lightweight?: string };
}

interface AppleSongResource {
  id?: string;
  attributes?: AppleSongAttributes;
}

interface AppleSongResponse {
  data?: AppleSongResource[];
}

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

function artworkUrl(artwork: AppleArtwork | undefined, size = 1200): string | undefined {
  if (!artwork?.url) return undefined;
  return artwork.url
    .replace("{w}", String(size))
    .replace("{h}", String(size))
    .replace("{f}", "jpg");
}

/** Normalises a catalog id; Apple accepts the `123456789` form only. */
export function normaliseSongId(rawId: string): string {
  const trimmed = rawId.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CatalogError(`invalid song id: ${rawId}`);
  }
  return trimmed;
}

/**
 * Fetch the renditions of one song.
 *
 * The response is cached per (storefront, id) for the lifetime of the process by
 * the caller — manifests are stable for hours and re-resolving them adds a
 * needless round trip to the start of every play.
 */
export async function resolveSong(
  songId: string,
  storefront: string,
  credentials: SessionCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<SongAsset> {
  const id = normaliseSongId(songId);
  if (!credentials.developerToken) {
    throw new CatalogError("no developer token: sign in to Apple Music first");
  }
  if (!credentials.mediaUserToken) {
    throw new CatalogError("no media user token: sign in to Apple Music first");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response | null = null;
  let lastStatus = 0;
  try {
    for (const root of API_ROOTS) {
      const url = new URL(`${root}/catalog/${encodeURIComponent(storefront)}/songs/${id}`);
      url.searchParams.set("extend", "extendedAssetUrls");
      response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${credentials.developerToken}`,
          "Media-User-Token": credentials.mediaUserToken,
          Origin: "https://music.apple.com",
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      lastStatus = response.status;
      if (response.ok) break;
    }
  } catch (error) {
    throw new CatalogError(
      `catalog request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response || !response.ok) {
    throw new CatalogError(`catalog request returned ${lastStatus}`, lastStatus);
  }

  const payload = (await response.json()) as AppleSongResponse;
  const resource = payload.data?.[0];
  const attributes = resource?.attributes;
  const manifestUrl = attributes?.extendedAssetUrls?.enhancedHls;
  if (!attributes || !manifestUrl) {
    throw new CatalogError(`no enhanced manifest for song ${id}`);
  }

  const asset: SongAsset = {
    id,
    storefront,
    name: attributes.name ?? "Unknown",
    artistName: attributes.artistName ?? "Unknown",
    albumName: attributes.albumName ?? "Unknown",
    durationMs: attributes.durationInMillis ?? 0,
    isrc: attributes.isrc,
    artworkUrl: artworkUrl(attributes.artwork),
    manifestUrl,
    audioTraits: attributes.audioTraits ?? [],
    contentRating: attributes.contentRating,
  };
  catalogLog.info(
    `resolved ${asset.name} (${asset.audioTraits.join(",") || "no traits"})`,
  );
  return asset;
}

/**
 * Fetch a URL as a stream, optionally as a byte range.
 *
 * The CDN expects the caller's own credentials for `enhancedHls` media; plain
 * `fetch` works because the manifest URLs are pre-signed.
 */
export async function fetchStream(
  url: string,
  init: { range?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.range) headers.Range = init.range;
  const response = await fetchImpl(url, { headers, signal: init.signal });
  if (!response.ok && response.status !== 206) {
    throw new CatalogError(`media request returned ${response.status}`, response.status);
  }
  return response;
}

/** Fetch a small text resource (a playlist or manifest) with a timeout. */
export async function fetchText(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new CatalogError(`manifest request returned ${response.status}`, response.status);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
