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
export function sampleLayout(segment: Buffer): SampleLayout {
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
        if (senc) {
          let ivLength = 8;
          if (sencFlags & 0x000002) {
            const subsampleCount = segment.readUInt16BE(sencCursor);
            sencCursor += 2 + subsampleCount * 6;
            if (subsampleCount > 0) {
              throw new Error("legacy decryptor does not support subsample encryption");
            }
          }
          iv = Buffer.from(segment.subarray(sencCursor, sencCursor + ivLength));
          sencCursor += ivLength;
        }

        if (size <= 0) throw new Error("trun declared a zero-sized sample");
        samples.push({ offset, size, iv });
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
  const layout = sampleLayout(segment);
  if (layout.samples.length === 0) {
    throw new Error("no samples found in fragment");
  }
  const output = Buffer.from(segment);
  for (const sample of layout.samples) {
    if (sample.offset + sample.size > output.length) {
      throw new Error("sample table points outside the fragment");
    }
    const ciphertext = Buffer.from(segment.subarray(sample.offset, sample.offset + sample.size));
    if (sample.iv && sample.iv.length > 0) {
      // The wrapper service decrypts with the key it armed; CBC needs the
      // sample IV to be part of the data only for cenc-style streams, which
      // Apple Music audio does not use. Reject rather than produce noise.
      throw new Error("per-sample IV streams are not supported by the legacy transport");
    }
    const plain = await decryptor.decrypt(ciphertext, request);
    plain.copy(output, sample.offset);
  }
  return output;
}
