/**
 * HLS manifest handling for Lidra's audio pipeline.
 *
 * Apple's `enhancedHls` URL (returned by the Apple Music API with
 * `extend=extendedAssetUrls`) is an HLS master playlist that lists every
 * quality tier for a song: AAC, ALAC lossless, hi-res ALAC and the Dolby
 * variants. The web player only ever selects the AAC variant, so Lidra parses
 * the master itself and picks the tier the user asked for.
 */

/** Quality tiers Lidra can stream, ordered from highest to lowest fidelity. */
export type QualityTier = "hi-res" | "lossless" | "atmos" | "dolby-audio" | "aac";

export const TIER_ORDER: readonly QualityTier[] = [
  "hi-res",
  "lossless",
  "atmos",
  "dolby-audio",
  "aac",
];

/** A selectable audio rendition from a master playlist. */
export interface AudioVariant {
  /** Absolute URL of the media playlist for this rendition. */
  uri: string;
  /** CODECS attribute; Apple uses `alac`, `ec-3`, `ac-3` and `mp4a.40.2`. */
  codecs: string;
  /** AUDIO attribute (Apple encodes the quality descriptor here). */
  audioGroup: string;
  /** Declared peak bandwidth in bits per second. */
  bandwidth: number;
  tier: QualityTier;
  /** Sample rate in Hz for ALAC renditions. */
  sampleRate?: number;
  /** Bit depth for ALAC renditions. */
  bitDepth?: number;
  /** Bitrate in kbps for lossy renditions. */
  bitrateKbps?: number;
  /** Channels attribute, when the manifest declares one, e.g. `16/JOC`. */
  channels?: string;
  /** Dolby Atmos delivered as E-AC-3 + Joint Object Coding (`CHANNELS="16/JOC"`). */
  joc?: boolean;
  /** Human readable label, e.g. `ALAC 24-bit/192 kHz`. */
  label: string;
}

/** A byte range inside a URL, as declared by `BYTERANGE`. */
export interface ByteRange {
  length: number;
  offset: number;
}

/** `EXT-X-MAP` initialisation section. */
export interface InitSection {
  uri: string;
  byterange?: ByteRange;
}

/** DRM key declaration from `EXT-X-KEY`. */
export interface KeyInfo {
  method: string;
  uri: string;
  iv?: Buffer;
}

/** One media segment of a media playlist. */
export interface MediaSegment {
  uri: string;
  duration: number;
  byterange?: ByteRange;
  /** Key in force for this segment, including inherited keys. */
  key?: KeyInfo;
}

/** Parsed media playlist, with URLs already resolved. */
export interface MediaPlaylist {
  targetDuration: number;
  mediaSequence: number;
  endList: boolean;
  playlistType?: string;
  map?: InitSection;
  segments: MediaSegment[];
}

interface AttributeMap {
  [key: string]: string;
}

function parseAttributes(input: string): AttributeMap {
  const attributes: AttributeMap = {};
  let index = 0;
  while (index < input.length) {
    const equals = input.indexOf("=", index);
    if (equals === -1) break;
    const name = input.slice(index, equals).trim();
    let value: string;
    let next: number;
    if (input[equals + 1] === '"') {
      const closing = input.indexOf('"', equals + 2);
      const end = closing === -1 ? input.length : closing;
      value = input.slice(equals + 2, end);
      next = end + 1;
      const comma = input.indexOf(",", next);
      next = comma === -1 ? input.length : comma + 1;
    } else {
      const comma = input.indexOf(",", equals + 1);
      const end = comma === -1 ? input.length : comma;
      value = input.slice(equals + 1, end);
      next = end + 1;
    }
    attributes[name] = value;
    index = next;
  }
  return attributes;
}

function parseByteRange(value: string, previous?: ByteRange): ByteRange {
  const [lengthText, offsetText] = value.split("@");
  const length = Number.parseInt(lengthText, 10);
  if (!Number.isFinite(length) || length <= 0) {
    throw new Error(`invalid BYTERANGE length: ${value}`);
  }
  const offset =
    offsetText === undefined
      ? previous === undefined
        ? 0
        : previous.offset + previous.length
      : Number.parseInt(offsetText, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error(`invalid BYTERANGE offset: ${value}`);
  }
  return { length, offset };
}

function resolveUrl(base: string, relative: string): string {
  return new URL(relative, base).toString();
}

/** Extract the numeric tokens of an Apple quality descriptor. */
function qualityTokens(audioGroup: string): number[] {
  return audioGroup
    .split("-")
    .map((token) => Number.parseInt(token, 10))
    .filter((value) => Number.isFinite(value));
}

/**
 * Classify one rendition. Apple's descriptors look like
 * `audio-alac-stereo-192000-24`, `audio-stereo-256`, `audio-atmos-2768` and
 * `audio-dolby-...`. The CODECS attribute is authoritative; the descriptor only
 * supplies the numbers.
 */
export function classifyVariant(
  codecs: string,
  audioGroup: string,
  bandwidth: number,
  channels?: string,
): Omit<AudioVariant, "uri"> {
  const tokens = qualityTokens(audioGroup);
  const codec = codecs.toLowerCase();

  if (codec === "alac") {
    // `...-<sampleRate>-<bitDepth>`; fall back to the trailing two numbers.
    const sampleRate = tokens.length >= 2 ? tokens[tokens.length - 2] : undefined;
    const bitDepth = tokens.length >= 1 ? tokens[tokens.length - 1] : undefined;
    const hiRes = sampleRate !== undefined && sampleRate > 48000;
    const khz = sampleRate === undefined ? "" : `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz`;
    return {
      codecs,
      audioGroup,
      bandwidth,
      tier: hiRes ? "hi-res" : "lossless",
      sampleRate,
      bitDepth,
      channels,
      label: `ALAC ${bitDepth ?? "?"}-bit/${khz || "?"}`,
    };
  }

  if (codec === "ec-3" || codec === "eac3") {
    const raw = tokens.length > 0 ? tokens[tokens.length - 1] : 0;
    // Apple writes atmos bitrates with a leading 2 (e.g. 2768 -> 768 kbps).
    const bitrateKbps = raw >= 2000 ? raw - 2000 : raw;
    return {
      codecs,
      audioGroup,
      bandwidth,
      tier: "atmos",
      bitrateKbps,
      channels,
      joc: (channels ?? "").toUpperCase().includes("JOC"),
      label: `Dolby Atmos ${bitrateKbps} kbps`,
    };
  }

  if (codec === "ac-3" || codec === "ac3") {
    const raw = tokens.length > 0 ? tokens[tokens.length - 1] : 0;
    return {
      codecs,
      audioGroup,
      bandwidth,
      tier: "dolby-audio",
      bitrateKbps: raw,
      channels,
      label: `Dolby Audio ${raw} kbps`,
    };
  }

  const bitrateKbps =
    tokens.length > 0
      ? tokens[tokens.length - 1]
      : Math.round(bandwidth / 1000);
  return {
    codecs,
    audioGroup,
    bandwidth,
    tier: "aac",
    bitrateKbps,
    channels,
    label: `AAC ${bitrateKbps} kbps`,
  };
}

/**
 * Parse an HLS master playlist into the renditions Lidra can choose between.
 * Both `EXT-X-STREAM-INF` and `EXT-X-MEDIA:TYPE=AUDIO` declarations are
 * consumed, because manifests in the wild use either shape.
 */
export function parseMasterPlaylist(text: string, baseUrl: string): AudioVariant[] {
  const lines = text.split(/\r?\n/);
  const variants: AudioVariant[] = [];
  const mediaByGroup = new Map<string, AttributeMap>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-MEDIA:")) {
      const attributes = parseAttributes(trimmed.slice("#EXT-X-MEDIA:".length));
      if ((attributes.TYPE ?? "").toUpperCase() === "AUDIO" && attributes["GROUP-ID"]) {
        mediaByGroup.set(attributes["GROUP-ID"], attributes);
      }
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attributes = parseAttributes(
      trimmed.slice("#EXT-X-STREAM-INF:".length),
    );
    let uriLine = "";
    for (let lookahead = index + 1; lookahead < lines.length; lookahead += 1) {
      const candidate = lines[lookahead].trim();
      if (candidate.length === 0 || candidate.startsWith("#")) continue;
      uriLine = candidate;
      break;
    }
    if (uriLine.length === 0) continue;

    const codecs = attributes.CODECS ?? "";
    const audioGroup = attributes.AUDIO ?? "";
    const bandwidth = Number.parseInt(attributes.BANDWIDTH ?? "0", 10) || 0;
    const media = audioGroup.length > 0 ? mediaByGroup.get(audioGroup) : undefined;
    const classified = classifyVariant(
      codecs,
      audioGroup.length > 0 ? audioGroup : media?.NAME ?? "",
      bandwidth,
      media?.CHANNELS,
    );

    // One descriptor can be listed twice (video + audio mux); de-duplicate by
    // tier and sample rate so the UI never shows the same quality twice.
    const duplicate = variants.some(
      (existing) =>
        existing.codecs === classified.codecs &&
        existing.audioGroup === classified.audioGroup &&
        existing.bandwidth === classified.bandwidth,
    );
    if (duplicate) continue;

    variants.push({
      ...classified,
      uri: resolveUrl(baseUrl, uriLine),
    });
  }

  return variants;
}

/** Sort variants from best to worst fidelity, keeping the manifest order stable. */
export function rankVariants(variants: readonly AudioVariant[]): AudioVariant[] {
  const score = (variant: AudioVariant): number => {
    const tierIndex = TIER_ORDER.indexOf(variant.tier);
    const tierScore = (TIER_ORDER.length - tierIndex) * 1_000_000;
    if (variant.tier === "hi-res" || variant.tier === "lossless") {
      return tierScore + (variant.sampleRate ?? 0) * 10 + (variant.bitDepth ?? 0);
    }
    return tierScore + (variant.bitrateKbps ?? 0);
  };
  return [...variants].sort((left, right) => score(right) - score(left));
}

/**
 * Pick the best variant for a preference.
 *
 * `preference` names the *floor*: `hi-res` falls back through lossless, Dolby
 * and AAC when the song has no hi-res master, which matches how Apple's own
 * clients degrade. `null` means "best available".
 */
export function selectVariant(
  variants: readonly AudioVariant[],
  preference: QualityTier | null,
): AudioVariant | null {
  if (variants.length === 0) return null;
  const ranked = rankVariants(variants);
  if (preference === null) return ranked[0];
  const best = ranked.find((variant) => variant.tier === preference);
  return best ?? ranked[0];
}

/** Parse an HLS media playlist, resolving URLs against `baseUrl`. */
export function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const playlist: MediaPlaylist = {
    targetDuration: 0,
    mediaSequence: 0,
    endList: false,
    segments: [],
  };
  let pendingDuration: number | null = null;
  let pendingByteRange: string | null = null;
  let pendingKey: KeyInfo | undefined;
  let currentKey: KeyInfo | undefined;
  let previousRange: ByteRange | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith("#EXT-X-TARGETDURATION:")) {
      playlist.targetDuration =
        Number.parseFloat(trimmed.slice("#EXT-X-TARGETDURATION:".length)) || 0;
      continue;
    }
    if (trimmed.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      playlist.mediaSequence =
        Number.parseInt(trimmed.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10) || 0;
      continue;
    }
    if (trimmed.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
      playlist.playlistType = trimmed.slice("#EXT-X-PLAYLIST-TYPE:".length).trim();
      continue;
    }
    if (trimmed.startsWith("#EXT-X-ENDLIST")) {
      playlist.endList = true;
      continue;
    }
    if (trimmed.startsWith("#EXT-X-KEY:")) {
      const attributes = parseAttributes(trimmed.slice("#EXT-X-KEY:".length));
      const method = attributes.METHOD ?? "";
      if (method.toUpperCase() === "NONE") {
        currentKey = undefined;
      } else if (attributes.URI) {
        const key: KeyInfo = { method, uri: attributes.URI };
        if (attributes.IV) key.iv = Buffer.from(attributes.IV.replace(/^0x/i, ""), "hex");
        currentKey = key;
      }
      continue;
    }
    if (trimmed.startsWith("#EXT-X-MAP:")) {
      const attributes = parseAttributes(trimmed.slice("#EXT-X-MAP:".length));
      if (attributes.URI) {
        playlist.map = { uri: resolveUrl(baseUrl, attributes.URI) };
        if (attributes.BYTERANGE) {
          playlist.map.byterange = parseByteRange(attributes.BYTERANGE);
        }
      }
      continue;
    }
    if (trimmed.startsWith("#EXT-X-BYTERANGE:")) {
      pendingByteRange = trimmed.slice("#EXT-X-BYTERANGE:".length).trim();
      continue;
    }
    if (trimmed.startsWith("#EXTINF:")) {
      const value = trimmed.slice("#EXTINF:".length).split(",")[0];
      pendingDuration = Number.parseFloat(value);
      continue;
    }
    if (trimmed.startsWith("#")) continue;

    // A URI line: completes the pending segment.
    const byterange = pendingByteRange
      ? parseByteRange(pendingByteRange, previousRange)
      : undefined;
    if (byterange) previousRange = byterange;
    playlist.segments.push({
      uri: resolveUrl(baseUrl, trimmed),
      duration: pendingDuration ?? 0,
      byterange,
      key: pendingKey ?? currentKey,
    });
    pendingDuration = null;
    pendingByteRange = null;
    pendingKey = undefined;
  }

  return playlist;
}

/** Total declared duration of a media playlist, in seconds. */
export function playlistDuration(playlist: MediaPlaylist): number {
  return playlist.segments.reduce((total, segment) => total + segment.duration, 0);
}

/** HTTP Range header value for a byte range. */
export function rangeHeader(range: ByteRange): string {
  return `bytes=${range.offset}-${range.offset + range.length - 1}`;
}
