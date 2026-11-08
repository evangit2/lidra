/**
 * In-place segment decryption for the wrapper decryptor transport.
 *
 * The wrapper service decrypts chunks, not files, so the fragment's sample table
 * has to be walked here: `tfhd` gives the base offset, `trun` the per-sample
 * sizes, and `senc` per-sample IVs when the stream uses them. Encrypted sample
 * payloads are then replaced in the mdat, in place, and the box structure is
 * left untouched — ffmpeg ignores `senc`/`saiz` once the initialisation segment
 * no longer advertises encryption.
 */
import type { LegacyDecryptor, LegacyRequest } from "./decryptor";

interface BoxView {
  type: string;
  /** Offset of the box header in the segment. */
  start: number;
  /** Offset of the payload (after size/type and any 64-bit or uuid fields). */
  payload: number;
  /** Offset one past the end of the box. */
  end: number;
}

const CONTAINER_BOXES = new Set(["moof", "traf", "mvex", "moov", "trak"]);

function readBoxes(buffer: Buffer, start: number, end: number): BoxView[] {
  const boxes: BoxView[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    let payload = offset + header;
    if (type === "uuid") payload += 16;
    boxes.push({ type, start: offset, payload, end: offset + size });
    offset += size;
  }
  return boxes;
}

export interface FragmentSample {
  /** Absolute offset of the sample's bytes inside the segment buffer. */
  offset: number;
  size: number;
  iv?: Buffer;
  /** cbcs subsample map: clear bytes then protected bytes, per entry. */
  subsamples?: { clear: number; protected: number }[];
}

export interface SampleLayout {
  trackId: number;
  samples: FragmentSample[];
  /** Number of moof/mdat pairs encountered. */
  fragments: number;
}

function readFullBoxFlags(buffer: Buffer, payload: number): number {
  return buffer.readUIntBE(payload + 1, 3);
}

/**
 * Extract per-sample byte ranges from an fMP4 chunk.
 *
 * Supports the layout Apple Music uses (`default-base-is-moof` with a `trun`
 * data offset) and the explicit `base-data-offset` variant.
 */
export function sampleLayout(segment: Buffer, perSampleIvSize = 8): SampleLayout {
  const top = readBoxes(segment, 0, segment.length);
  const samples: FragmentSample[] = [];
  let trackId = 0;
  let fragments = 0;

  for (const box of top) {
    if (box.type !== "moof") continue;
    fragments += 1;
    for (const traf of readBoxes(segment, box.payload, box.end)) {
      if (traf.type !== "traf") continue;
      const children = readBoxes(segment, traf.payload, traf.end);
      const tfhd = children.find((child) => child.type === "tfhd");
      const trun = children.find((child) => child.type === "trun");
      const senc = children.find((child) => child.type === "senc");
      if (!tfhd || !trun) continue;

      const tfhdFlags = readFullBoxFlags(segment, tfhd.payload);
      let cursor = tfhd.payload + 4;
      trackId = segment.readUInt32BE(cursor);
      cursor += 4;
      let baseDataOffset = box.start;
      if (tfhdFlags & 0x000001) {
        baseDataOffset = Number(segment.readBigUInt64BE(cursor));
        cursor += 8;
      }
      if (tfhdFlags & 0x000002) cursor += 4; // sample_description_index
      let defaultSampleSize = 0;
      if (tfhdFlags & 0x000008) cursor += 4; // default_sample_duration
      if (tfhdFlags & 0x000010) {
        defaultSampleSize = segment.readUInt32BE(cursor);
        cursor += 4;
      }
      if (tfhdFlags & 0x000020) cursor += 4; // default_sample_flags

      const trunFlags = readFullBoxFlags(segment, trun.payload);
      let trunCursor = trun.payload + 4;
      const sampleCount = segment.readUInt32BE(trunCursor);
      trunCursor += 4;
      let dataOffset = 0;
      if (trunFlags & 0x000001) {
        dataOffset = segment.readInt32BE(trunCursor);
        trunCursor += 4;
      }
      if (trunFlags & 0x000004) trunCursor += 4; // first_sample_flags

      // Per-sample IVs, when present, line up with the sample order.
      let sencCursor = senc ? senc.payload + 4 : 0;
      const sencFlags = senc ? readFullBoxFlags(segment, senc.payload) : 0;
      // Apple's senc repeats the sample count before the entries; the ISO layout
      // does not. Trust the value only when it matches, so both parse correctly.
      if (senc && sencCursor + 4 <= segment.length && segment.readUInt32BE(sencCursor) === sampleCount) {
        sencCursor += 4;
      }

      let offset = baseDataOffset + dataOffset;
      for (let index = 0; index < sampleCount; index += 1) {
        let size = defaultSampleSize;
        if (trunFlags & 0x000100) trunCursor += 4;
        if (trunFlags & 0x000200) {
          size = segment.readUInt32BE(trunCursor);
          trunCursor += 4;
        }
        if (trunFlags & 0x000400) trunCursor += 4;
        if (trunFlags & 0x000800) trunCursor += 4;

        let iv: Buffer | undefined;
        let subsamples: { clear: number; protected: number }[] | undefined;
        if (senc) {
          // ISO/IEC 23001-7: each senc entry is IV first, then the subsample table.
          // Reading them the other way shifts every entry and turns the table into
          // noise.
          if (perSampleIvSize > 0) {
            iv = Buffer.from(segment.subarray(sencCursor, sencCursor + perSampleIvSize));
            sencCursor += perSampleIvSize;
          }
          if (sencFlags & 0x000002) {
            const subsampleCount = segment.readUInt16BE(sencCursor);
            sencCursor += 2;
            if (subsampleCount > 0) {
              subsamples = [];
              for (let entry = 0; entry < subsampleCount; entry += 1) {
                const clear = segment.readUInt16BE(sencCursor);
                const protectedBytes = segment.readUInt32BE(sencCursor + 2);
                sencCursor += 6;
                subsamples.push({ clear, protected: protectedBytes });
              }
            }
          }
        }

        if (size <= 0) throw new Error("trun declared a zero-sized sample");
        samples.push({ offset, size, iv, subsamples });
        offset += size;
      }
    }
  }

  return { trackId, samples, fragments };
}

/**
 * Decrypt every sample of a fragment through the wrapper service.
 * Returns a same-length copy with the ciphertext replaced by plaintext.
 */
/**
 * Sanity-check decrypted audio before it reaches the transcoder.
 *
 * The wrapper pins one key context per song for the life of its process, so a
 * wrong arm does not fail — it returns plausible-looking noise. Every ALAC
 * frame repeats the same header bits and every AC-3/EC-3 frame starts with the
 * 0x0b77 sync word, which is enough to tell real plaintext from noise.
 */
export function verifyFragmentPlaintext(
  output: Buffer,
  layout: SampleLayout,
): { ok: boolean; reason?: string } {
  if (layout.samples.length === 0) return { ok: false, reason: "fragment has no samples" };
  const head = (index: number): Buffer => {
    const sample = layout.samples[index];
    return output.subarray(sample.offset, sample.offset + 4);
  };
  const first = head(0);
  if (first.length < 4) return { ok: false, reason: "sample outside the fragment" };
  const isAc3 = first[0] === 0x0b && first[1] === 0x77;
  if (isAc3) {
    let matching = 0;
    for (let index = 0; index < layout.samples.length; index += 1) {
      const sample = head(index);
      if (sample[0] === 0x0b && sample[1] === 0x77) matching += 1;
    }
    const ratio = matching / layout.samples.length;
    return ratio >= 0.95
      ? { ok: true }
      : { ok: false, reason: `only ${(ratio * 100).toFixed(0)}% of frames carry the AC-3 sync word` };
  }
  // ALAC: the frame header's first three bytes depend only on the stream format,
  // so they repeat for every frame of a healthy fragment.
  const prefix = first.subarray(0, 3);
  let matching = 0;
  for (let index = 0; index < layout.samples.length; index += 1) {
    if (head(index).subarray(0, 3).equals(prefix)) matching += 1;
  }
  const ratio = matching / layout.samples.length;
  return ratio >= 0.95
    ? { ok: true }
    : { ok: false, reason: `only ${(ratio * 100).toFixed(0)}% of frames share the ALAC header` };
}

/** Raised when the decryptor returns noise instead of plaintext. */
export class DecryptMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptMismatchError";
  }
}

/**
 * Decrypt every sample of a fragment through the wrapper service.
 *
 * Returns a same-length copy with the ciphertext replaced by plaintext. All the
 * protected spans of the fragment travel in one pipelined batch: the service is
 * stateless per span, and waiting for a round trip per sample is what made
 * lossless start-up slow.
 */
export async function decryptSegmentLegacy(
  segment: Buffer,
  decryptor: LegacyDecryptor,
  request: LegacyRequest,
): Promise<Buffer> {
  const layout = sampleLayout(segment, request.perSampleIvSize ?? 0);
  if (layout.samples.length === 0) {
    throw new Error("no samples found in fragment");
  }
  for (const sample of layout.samples) {
    if (sample.offset + sample.size > segment.length) {
      throw new Error("sample table points outside the fragment");
    }
    if (sample.iv && sample.iv.length > 0) {
      // The wrapper decrypts with the key it armed and carries the constant IV
      // for the track; per-sample IVs would have to travel on the wire, which
      // this transport does not do.
      throw new Error("per-sample IV streams are not supported by the legacy transport");
    }
  }

  // Arm at the fragment boundary: a key change needs the switch marker, and
  // arming is a queued operation that must not run inside the decrypt batch.
  await decryptor.armFragment(request);

  const cryptBlocks = request.cryptByteBlock ?? 0;
  const skipBlocks = request.skipByteBlock ?? 0;

  /** Split one protected span into the runs the service should decrypt. */
  const runsOf = (span: Buffer): Buffer[] => {
    if (cryptBlocks === 0 || skipBlocks === 0) return [span];
    const cryptBytes = cryptBlocks * 16;
    const stride = cryptBytes + skipBlocks * 16;
    const chunks: Buffer[] = [];
    for (let pos = 0; pos + cryptBytes <= span.length; pos += stride) {
      chunks.push(span.subarray(pos, pos + cryptBytes));
    }
    return chunks;
  };

  // Gather every protected span in sample order, remembering where it belongs.
  const plan: { target: number; span: number; run: Buffer; order: number }[] = [];
  const runs: Buffer[] = [];
  for (const sample of layout.samples) {
    const spans: { start: number; length: number }[] = [];
    if (sample.subsamples && sample.subsamples.length > 0) {
      let cursor = 0;
      for (const entry of sample.subsamples) {
        cursor += entry.clear;
        if (entry.protected === 0) continue;
        if (cursor + entry.protected > sample.size) {
          throw new Error("subsample exceeds the sample buffer");
        }
        spans.push({ start: sample.offset + cursor, length: entry.protected });
        cursor += entry.protected;
      }
    } else {
      spans.push({ start: sample.offset, length: sample.size });
    }
    for (const span of spans) {
      const piece = segment.subarray(span.start, span.start + span.length);
      const pieces = runsOf(piece);
      if (pieces.length === 1 && pieces[0] === piece) {
        plan.push({ target: span.start, span: span.length, run: piece, order: runs.length });
        runs.push(piece);
        continue;
      }
      // Pattern encryption: the decrypt blocks travel as one run and are
      // scattered back into the span afterwards.
      const gathered = Buffer.concat(pieces);
      plan.push({ target: span.start, span: span.length, run: gathered, order: runs.length });
      runs.push(gathered);
    }
  }

  const plains = await decryptor.decryptBatch(runs, request);
  const output = Buffer.from(segment);
  for (const entry of plan) {
    const plain = plains[entry.order];
    const striped = cryptBlocks !== 0 && skipBlocks !== 0 && plain.length !== entry.span;
    if (!striped) {
      plain.copy(output, entry.target, 0, entry.span);
      continue;
    }
    const cryptBytes = cryptBlocks * 16;
    const stride = cryptBytes + skipBlocks * 16;
    let read = 0;
    for (let pos = 0; pos + cryptBytes <= entry.span; pos += stride) {
      plain.copy(output, entry.target + pos, read, read + cryptBytes);
      read += cryptBytes;
    }
  }

  const check = verifyFragmentPlaintext(output, layout);
  if (!check.ok) {
    throw new DecryptMismatchError(`decrypted fragment failed verification: ${check.reason}`);
  }
  return output;
}
