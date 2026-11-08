/**
 * Delivered-quality verification.
 *
 * Lidra's claim is that a request for a tier returns that tier. The encrypted
 * media fragments cannot be inspected without keys, but the initialisation
 * segment is always in the clear and carries the exact codec configuration the
 * stream will be decoded with: ALAC's magic cookie, E-AC-3/AC-3's dec3/dac3,
 * and AAC's AudioSpecificConfig. Reading those proves the delivered format,
 * bit depth, sample rate, channel count and bitrate — no keys, no guessing.
 */
import { parseBoxes, type BoxInfo } from "./mp4/box";
import type { AudioVariant, QualityTier } from "./hls";

/** What a stream actually is, as declared by its own codec configuration. */
export interface StreamFacts {
  codec: "alac" | "flac" | "ec-3" | "ac-3" | "aac" | "unknown";
  sampleRate: number;
  bitDepth: number | null;
  channels: number;
  /** Declared average bitrate in kbps, when the configuration carries one. */
  bitrateKbps: number | null;
  /** For E-AC-3: whether the substream layout indicates a Dolby Atmos bed. */
  atmos: boolean;
  /** Human readable summary, e.g. `ALAC 24-bit/192 kHz stereo`. */
  label: string;
  /** Tier this stream genuinely belongs to. */
  tier: QualityTier;
}

export class QualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityError";
  }
}

const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

const AC3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];

const AC3_RATES = [48000, 44100, 32000, 0];

/** Channels implied by acmod (Coding Mode), excluding the LFE channel. */
const ACMOD_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];

function childBoxes(buffer: Buffer, box: BoxInfo): BoxInfo[] {
  try {
    return parseBoxes(buffer, box.payloadOffset, box.payloadOffset + box.payloadSize);
  } catch {
    return [];
  }
}

function findChild(buffer: Buffer, box: BoxInfo, type: string): BoxInfo | null {
  return childBoxes(buffer, box).find((child) => child.type === type) ?? null;
}

interface SampleEntry {
  format: string;
  /** Offset of the sample entry's own payload (after the 8-byte box header). */
  start: number;
  end: number;
  channels: number;
  sampleSize: number;
  sampleRate: number;
}

/** Locate the first audio sample entry inside an init segment's stsd box. */
function firstSampleEntry(init: Buffer): SampleEntry {
  let offset = 0;
  let size = init.length;
  let moov: BoxInfo | null = null;
  for (const box of parseBoxes(init, offset, size)) {
    if (box.type === "moov") moov = box;
  }
  if (!moov) throw new QualityError("init segment has no moov box");

  const trak = findChild(init, moov, "trak");
  if (!trak) throw new QualityError("init segment has no trak box");
  const mdia = findChild(init, trak, "mdia");
  if (!mdia) throw new QualityError("track has no mdia box");
  const minf = findChild(init, mdia, "minf");
  if (!minf) throw new QualityError("track has no minf box");
  const stbl = findChild(init, minf, "stbl");
  if (!stbl) throw new QualityError("track has no stbl box");
  const stsd = findChild(init, stbl, "stsd");
  if (!stsd) throw new QualityError("track has no stsd box");

  // stsd is a full box: version/flags then entry_count.
  const entryCount = stsd.payloadSize >= 8 ? init.readUInt32BE(stsd.payloadOffset + 4) : 0;
  if (entryCount === 0) throw new QualityError("stsd lists no sample entries");

  const entries = parseBoxes(init, stsd.payloadOffset + 8, stsd.payloadOffset + stsd.payloadSize);
  if (entries.length === 0) throw new QualityError("stsd entries are unreadable");
  // Apple protects audio by wrapping the real sample entry in `enca`; the
  // original format is then only in sinf/frma. Pick the first entry that
  // resolves to a codec we understand.
  let entry: BoxInfo | null = null;
  let format = "";
  for (const candidate of entries) {
    if (candidate.payloadSize < 28) continue;
    const resolved = resolveFormat(init, candidate);
    if (resolved) {
      entry = candidate;
      format = resolved;
      break;
    }
  }
  if (!entry) {
    const first = entries[0] as BoxInfo;
    throw new QualityError(`unsupported sample entry ${first.type}`);
  }

  // AudioSampleEntry: 6 reserved + 2 data_reference_index, then 8 bytes of
  // version/revision/vendor, then channelcount, samplesize, pre_defined,
  // reserved, samplerate (16.16 fixed point).
  const base = entry.payloadOffset;
  const channels = init.readUInt16BE(base + 16);
  const sampleSize = init.readUInt16BE(base + 18);
  const sampleRate = init.readUInt32BE(base + 24) / 65536;

  return {
    format,
    start: base,
    end: entry.payloadOffset + entry.payloadSize,
    channels,
    sampleSize,
    sampleRate,
  };
}

const KNOWN_FORMATS = new Set(["alac", "fLaC", "flac", "ec-3", "eac3", "ac-3", "ac3", "mp4a"]);

/**
 * Boxes nested inside an audio sample entry (ALAC's cookie, dec3, dac3, esds).
 * Children sit after the 28-byte AudioSampleEntry header; QuickTime version 1
 * descriptions add 16 bytes. Apple's own segments sometimes add 4 more, so all
 * plausible offsets are tried and the one whose boxes chain exactly to the end
 * of the entry wins.
 */
function entryChildren(init: Buffer, entry: SampleEntry): BoxInfo[] {
  let best: BoxInfo[] = [];
  for (const start of [entry.start + 28, entry.start + 32, entry.start + 44, entry.start + 48]) {
    if (start + 8 > entry.end) continue;
    try {
      const parsed = parseBoxes(init, start, entry.end);
      if (parsed.length > best.length) best = parsed;
    } catch {
      // Wrong offset for this version; try the next one.
    }
  }
  return best;
}

function findEntryBox(init: Buffer, entry: SampleEntry, type: string): BoxInfo | null {
  return entryChildren(init, entry).find((child) => child.type === type) ?? null;
}

/** Resolve the real codec of a sample entry, following sinf/frma for `enca`. */
function resolveFormat(init: Buffer, entry: BoxInfo): string | null {
  if (KNOWN_FORMATS.has(entry.type)) return entry.type;
  if (entry.type !== "enca" && entry.type !== "encv") return null;
  const pseudo: SampleEntry = {
    format: entry.type,
    start: entry.payloadOffset,
    end: entry.payloadOffset + entry.payloadSize,
    channels: 0,
    sampleSize: 0,
    sampleRate: 0,
  };
  const sinf = findEntryBox(init, pseudo, "sinf");
  if (!sinf) return null;
  const frma = findChild(init, sinf, "frma");
  if (!frma || frma.payloadSize < 4) return null;
  const original = init.toString("latin1", frma.payloadOffset, frma.payloadOffset + 4);
  return KNOWN_FORMATS.has(original) ? original : null;
}

/** ALAC magic cookie: bit depth, channels, average bitrate and rate. */
function readAlacCookie(init: Buffer, entry: SampleEntry): Partial<StreamFacts> {
  const cookie = findEntryBox(init, entry, "alac");
  const raw = cookie
    ? init.subarray(cookie.payloadOffset, cookie.payloadOffset + cookie.payloadSize)
    : null;
  // The cookie is 24 bytes; a full-box version/flags word may precede it.
  const cookieBody = raw && raw.length >= 24 ? raw.subarray(raw.length - 24) : null;
  if (!cookieBody) {
    // Fall back to the sample entry fields, which Apple always fills in.
    return {
      bitDepth: entry.sampleSize > 0 ? entry.sampleSize : null,
      channels: entry.channels,
      sampleRate: entry.sampleRate,
    };
  }
  return {
    bitDepth: cookieBody.readUInt8(5),
    channels: cookieBody.readUInt8(9),
    sampleRate: cookieBody.readUInt32BE(20),
    bitrateKbps: Math.round(cookieBody.readUInt32BE(16) / 1000) || null,
  };
}

/** E-AC-3 specific box (dec3). */
function readDec3(init: Buffer, box: BoxInfo): Partial<StreamFacts> {
  const payload = init.subarray(box.payloadOffset, box.payloadOffset + box.payloadSize);
  if (payload.length < 5) return {};
  const dataRate = payload.readUInt16BE(0) >> 3;
  const substreams = (payload.readUInt16BE(0) & 0x07) + 1;
  const first = payload.subarray(2, 5);
  const bits = (first[0] << 16) | (first[1] << 8) | (first[2] as number);
  const fscod = (bits >> 22) & 0x03;
  // EC3SpecificBox: fscod(2) bsid(5) reserved(1) asvc(1) bsmod(3) acmod(3)
  // lfeon(1) reserved(3) num_dep_sub(4) reserved(1).
  const acmod = (bits >> 9) & 0x07;
  const lfeon = (bits >> 8) & 0x01;
  const channels = (ACMOD_CHANNELS[acmod] ?? 2) + (lfeon ? 1 : 0);
  // Atmos beds are delivered as 5.1/7.1 E-AC-3 with dependent substreams; a
  // stereo ec-3 rendition is plain Dolby Digital Plus.
  const atmos = substreams > 1 || channels > 2;
  return {
    sampleRate: AC3_RATES[fscod] || 0,
    channels,
    bitrateKbps: dataRate,
    atmos,
  };
}

/** AC-3 specific box (dac3). */
function readDac3(init: Buffer, box: BoxInfo): Partial<StreamFacts> {
  const payload = init.subarray(box.payloadOffset, box.payloadOffset + box.payloadSize);
  if (payload.length < 3) return {};
  const bits = (payload[0] << 16) | (payload[1] << 8) | (payload[2] as number);
  const fscod = (bits >> 22) & 0x03;
  const acmod = (bits >> 11) & 0x07;
  const lfeon = (bits >> 10) & 0x01;
  const bitrateCode = (bits >> 5) & 0x1f;
  return {
    sampleRate: AC3_RATES[fscod] || 0,
    channels: (ACMOD_CHANNELS[acmod] ?? 2) + (lfeon ? 1 : 0),
    bitrateKbps: AC3_BITRATES[bitrateCode] ?? null,
  };
}

/** Minimal descriptor walker for esds (ISO 14496-1). */
function readDescriptors(buffer: Buffer): { tag: number; body: Buffer }[] {
  const out: { tag: number; body: Buffer }[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const tag = buffer[offset] as number;
    offset += 1;
    let length = 0;
    for (let index = 0; index < 4; index += 1) {
      if (offset >= buffer.length) return out;
      const byte = buffer[offset] as number;
      offset += 1;
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    if (length <= 0 || offset + length > buffer.length) return out;
    const body = buffer.subarray(offset, offset + length);
    out.push({ tag, body });
    // ES_Descriptor wraps its own descriptors after ES_ID (2) and flags (1).
    if (tag === 0x03 && body.length > 3) {
      for (const nested of readDescriptors(body.subarray(3))) out.push(nested);
    }
    offset += length;
  }
  return out;
}

/** AudioSpecificConfig: sample rate and channel configuration. */
function parseAudioSpecificConfig(config: Buffer): { sampleRate: number; channels: number } {
  if (config.length < 2) return { sampleRate: 0, channels: 0 };
  const bits = (config[0] << 16) | (config[1] << 8) | (config[2] ?? 0);
  let cursor = 5; // audioObjectType
  const objectType = (bits >> 19) & 0x1f;
  if (objectType === 31) cursor += 6;
  const bitReader = (start: number, count: number): number => {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const at = start + index;
      const byte = config[at >> 3] ?? 0;
      value = (value << 1) | ((byte >> (7 - (at & 7))) & 1);
    }
    return value;
  };
  const frequencyIndex = bitReader(cursor, 4);
  cursor += 4;
  let sampleRate = AAC_RATES[frequencyIndex] ?? 0;
  if (frequencyIndex === 0x0f) {
    sampleRate = bitReader(cursor, 24);
    cursor += 24;
  }
  const channelConfig = bitReader(cursor, 4);
  const channels = channelConfig === 7 ? 8 : channelConfig === 0 ? 0 : channelConfig;
  return { sampleRate, channels };
}

/** Read the codec configuration out of an initialisation segment. */
export function inspectInitSegment(init: Buffer): StreamFacts {
  if (init.length < 16) throw new QualityError("init segment is too small to inspect");
  const entry = firstSampleEntry(init);

  let facts: StreamFacts = {
    codec: "unknown",
    sampleRate: entry.sampleRate,
    bitDepth: null,
    channels: entry.channels,
    bitrateKbps: null,
    atmos: false,
    label: "",
    tier: "aac",
  };

  if (entry.format === "alac") {
    const alac = readAlacCookie(init, entry);
    facts = {
      ...facts,
      codec: "alac",
      sampleRate: alac.sampleRate || entry.sampleRate,
      bitDepth: alac.bitDepth ?? null,
      channels: alac.channels || entry.channels,
      bitrateKbps: alac.bitrateKbps ?? null,
    };
  } else if (entry.format === "fLaC" || entry.format === "flac") {
    facts = { ...facts, codec: "flac" };
  } else if (entry.format === "ec-3" || entry.format === "eac3") {
    const dec3 = findEntryBox(init, entry, "dec3");
    const parsed = dec3 ? readDec3(init, dec3) : {};
    facts = { ...facts, codec: "ec-3", ...parsed };
  } else if (entry.format === "ac-3" || entry.format === "ac3") {
    const dac3 = findEntryBox(init, entry, "dac3");
    const parsed = dac3 ? readDac3(init, dac3) : {};
    facts = { ...facts, codec: "ac-3", ...parsed };
  } else if (entry.format === "mp4a") {
    const esds = findEntryBox(init, entry, "esds");
    if (esds) {
      const descriptors = readDescriptors(
        init.subarray(esds.payloadOffset + 4, esds.payloadOffset + esds.payloadSize),
      );
      const decoderConfig = descriptors.find((descriptor) => descriptor.tag === 0x04);
      const specific = descriptors.find((descriptor) => descriptor.tag === 0x05);
      if (decoderConfig && decoderConfig.body.length >= 13) {
        facts.bitrateKbps = Math.round(decoderConfig.body.readUInt32BE(9) / 1000) || null;
      }
      if (specific) {
        const asc = parseAudioSpecificConfig(specific.body);
        facts.sampleRate = asc.sampleRate || facts.sampleRate;
        facts.channels = asc.channels || facts.channels;
      }
    }
    facts.codec = "aac";
  }

  // Apple's own ladder calls a lossless stream "hi-res" only above 48 kHz. A
  // 24-bit/44.1 kHz ALAC is lossless with 24-bit depth, not a hi-res rendition,
  // and the label keeps the depth visible either way.
  const tier: QualityTier =
    facts.codec === "alac" || facts.codec === "flac"
      ? facts.sampleRate > 48000
        ? "hi-res"
        : "lossless"
      : facts.codec === "ec-3"
        ? "atmos"
        : facts.codec === "ac-3"
          ? "dolby-audio"
          : "aac";
  const label = describeStream({ ...facts, tier });
  return { ...facts, tier, label };
}

/** Compact label for UI and logs. */
export function describeStream(facts: StreamFacts): string {
  const channels =
    facts.channels === 1
      ? "mono"
      : facts.channels === 2
        ? "stereo"
        : `${facts.channels} channels`;
  const rate = facts.sampleRate >= 1000 ? `${(facts.sampleRate / 1000).toFixed(
    facts.sampleRate % 1000 === 0 ? 0 : 1,
  )} kHz` : "unknown rate";
  switch (facts.codec) {
    case "alac":
      return `ALAC ${facts.bitDepth ?? "?"}-bit/${rate} ${channels}`;
    case "flac":
      return `FLAC ${facts.bitDepth ?? "?"}-bit/${rate} ${channels}`;
    case "ec-3":
      return `Dolby Digital Plus${facts.atmos ? " (Atmos)" : ""} ${rate} ${channels}${
        facts.bitrateKbps ? ` ${facts.bitrateKbps} kbps` : ""
      }`;
    case "ac-3":
      return `Dolby Digital ${rate} ${channels}${facts.bitrateKbps ? ` ${facts.bitrateKbps} kbps` : ""}`;
    case "aac":
      return `AAC ${rate} ${channels}${facts.bitrateKbps ? ` ${facts.bitrateKbps} kbps` : ""}`;
    default:
      return "unknown stream";
  }
}

export interface QualityCheck {
  tier: QualityTier;
  label: string;
  /** Problems found between what was requested and what was delivered. */
  mismatches: string[];
  ok: boolean;
}

/**
 * Compare what the manifest promised with what the stream's codec configuration
 * actually says. Returns the truth plus any contradictions.
 */
export function verifyAgainstVariant(variant: AudioVariant, facts: StreamFacts): QualityCheck {
  const mismatches: string[] = [];

  if (variant.tier !== facts.tier) {
    mismatches.push(`requested ${variant.tier} but the stream is ${facts.tier}`);
  }
  if (variant.sampleRate && facts.sampleRate && variant.sampleRate !== facts.sampleRate) {
    mismatches.push(
      `manifest declared ${variant.sampleRate} Hz but the stream is ${facts.sampleRate} Hz`,
    );
  }
  if (variant.bitDepth && facts.bitDepth && variant.bitDepth !== facts.bitDepth) {
    mismatches.push(
      `manifest declared ${variant.bitDepth}-bit but the stream is ${facts.bitDepth}-bit`,
    );
  }
  if (variant.bitrateKbps && facts.bitrateKbps) {
    const drift = Math.abs(variant.bitrateKbps - facts.bitrateKbps) / variant.bitrateKbps;
    if (drift > 0.15) {
      mismatches.push(
        `manifest declared ${variant.bitrateKbps} kbps but the stream is ${facts.bitrateKbps} kbps`,
      );
    }
  }
  if ((variant.tier === "lossless" || variant.tier === "hi-res") && facts.bitDepth === null) {
    mismatches.push("lossless stream has no bit depth in its codec configuration");
  }

  return { tier: facts.tier, label: facts.label, mismatches, ok: mismatches.length === 0 };
}
