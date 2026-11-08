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
export async function decryptSegmentLegacy(
  segment: Buffer,
  decryptor: LegacyDecryptor,
  request: LegacyRequest,
): Promise<Buffer> {
  const layout = sampleLayout(segment, request.perSampleIvSize ?? 8);
  if (layout.samples.length === 0) {
    throw new Error("no samples found in fragment");
  }
  // Re-arm at the fragment boundary so the service's per-fragment state matches.
  await decryptor.armFragment(request);

  const output = Buffer.from(segment);
  const cryptBlocks = request.cryptByteBlock ?? 0;
  const skipBlocks = request.skipByteBlock ?? 0;

  /**
   * Decrypt one protected span. cbcs encrypts `crypt` blocks then skips `skip`
   * blocks; the wrapper only sees ciphertext, so the decrypt blocks are gathered
   * into one run and scattered back afterwards.
   */
  const decryptSpan = async (span: Buffer): Promise<Buffer> => {
    if (cryptBlocks === 0 || skipBlocks === 0) {
      return decryptor.decrypt(span, request);
    }
    const cryptBytes = cryptBlocks * 16;
    const stride = cryptBytes + skipBlocks * 16;
    const chunks: Buffer[] = [];
    for (let pos = 0; pos + cryptBytes <= span.length; pos += stride) {
      chunks.push(span.subarray(pos, pos + cryptBytes));
    }
    if (chunks.length === 0) return span;
    const gathered = Buffer.concat(chunks);
    const plainGathered = await decryptor.decrypt(gathered, request);
    const result = Buffer.from(span);
    let read = 0;
    for (let pos = 0; pos + cryptBytes <= span.length; pos += stride) {
      plainGathered.copy(result, pos, read, read + cryptBytes);
      read += cryptBytes;
    }
    return result;
  };

  for (const sample of layout.samples) {
    if (sample.offset + sample.size > output.length) {
      throw new Error("sample table points outside the fragment");
    }
    const ciphertext = Buffer.from(segment.subarray(sample.offset, sample.offset + sample.size));
    if (sample.iv && sample.iv.length > 0) {
      // The wrapper decrypts with the key it armed and carries the constant IV
      // for the track; per-sample IVs would have to travel on the wire, which
      // this transport does not do.
      throw new Error("per-sample IV streams are not supported by the legacy transport");
    }
    if (process.env.LIDRA_DEBUG_SUBS && sample.subsamples) {
      const total = sample.subsamples.reduce((sum, e) => sum + e.clear + e.protected, 0);
      if (total !== sample.size) {
        console.warn(`[subs] sample size=${sample.size} table=${total} entries=${sample.subsamples.length}`);
      }
    }
    if (sample.subsamples && sample.subsamples.length > 0) {
      let cursor = 0;
      for (const entry of sample.subsamples) {
        cursor += entry.clear;
        if (entry.protected === 0) continue;
        const span = ciphertext.subarray(cursor, cursor + entry.protected);
        if (span.length !== entry.protected) {
          throw new Error("subsample exceeds the sample buffer");
        }
        const plainSpan = await decryptSpan(Buffer.from(span));
        if (process.env.LIDRA_DEBUG_SUBS && sample.offset < 12000) {
          console.warn(
            `[sub] off=${sample.offset} size=${sample.size} clear=${entry.clear} prot=${entry.protected} enc=${span.subarray(0, 16).toString("hex")} plain=${plainSpan.subarray(0, 16).toString("hex")}`,
          );
        }
        plainSpan.copy(output, sample.offset + cursor);
        cursor += entry.protected;
      }
      continue;
    }
    const plain = await decryptSpan(ciphertext);
    if (process.env.LIDRA_DEBUG_SUBS && output.length > 0 && sample.offset < 12000) {
      console.warn(
        `[sample] off=${sample.offset} size=${sample.size} enc=${ciphertext.subarray(0, 16).toString("hex")} plain=${plain.subarray(0, 16).toString("hex")}`,
      );
    }
    plain.copy(output, sample.offset);
  }
  return output;
}
