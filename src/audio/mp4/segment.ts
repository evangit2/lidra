import { createDecipheriv } from "node:crypto";
import { parseBoxes, makeBox, makeFullBox } from "./box";
import type { SampleEncryption, SegmentSample, InitInfo, AesBackend } from "./types";

function normalizeInfo(info: SampleEncryption | InitInfo): SampleEncryption {
  if ((info as InitInfo).encryption !== undefined) {
    return (info as InitInfo).encryption;
  }
  return info as SampleEncryption;
}

export function localAesBackend(key: Buffer): AesBackend {
  if (!Buffer.isBuffer(key) || key.length !== 16) throw new Error("key must be 16 bytes");
  return {
    decrypt(data: Buffer, iv: Buffer): Buffer {
      if (data.length === 0) return Buffer.alloc(0);
      if (data.length % 16 !== 0) throw new Error("AES-CBC data must be multiple of 16");
      if (!Buffer.isBuffer(iv) || iv.length !== 16) throw new Error("IV must be 16 bytes");
      const decipher = createDecipheriv("aes-128-cbc", key, iv);
      decipher.setAutoPadding(false);
      return Buffer.concat([decipher.update(data), decipher.final()]);
    },
  };
}

function isAesBackend(v: unknown): v is AesBackend {
  return typeof v === "object" && v !== null && typeof (v as AesBackend).decrypt === "function";
}

function resolveBackend(keyOrBackend: Buffer | AesBackend): AesBackend {
  if (isAesBackend(keyOrBackend as unknown as object)) return keyOrBackend as AesBackend;
  return localAesBackend(keyOrBackend as Buffer);
}

function expandIv8to16(iv: Buffer): Buffer {
  if (iv.length === 16) return iv;
  if (iv.length === 8) {
    const out = Buffer.alloc(16, 0);
    iv.copy(out, 0);
    return out;
  }
  throw new Error(`IV length must be 8 or 16, got ${iv.length}`);
}

// ----- CBCS helpers using backend -----

function cbcsDecryptFull(data: Buffer, backend: AesBackend, iv: Buffer): void {
  const truncated = data.length & ~0xf;
  if (truncated === 0) return;
  const slice = data.subarray(0, truncated);
  const dec = backend.decrypt(Buffer.from(slice), iv);
  dec.copy(data, 0);
}

function cbcsDecryptPattern(data: Buffer, backend: AesBackend, iv: Buffer, cryptBlocks: number, skipBlocks: number): void {
  if (cryptBlocks === 0 && skipBlocks === 0) {
    cbcsDecryptFull(data, backend, iv);
    return;
  }
  const cryptLen = cryptBlocks * 16;
  const skipLen = skipBlocks * 16;
  if (cryptLen === 0) return;
  if (data.length < cryptLen) return;
  let count = 0;
  let pos = 0;
  while (pos + cryptLen <= data.length) {
    count++;
    pos += cryptLen;
    if (pos + skipLen > data.length) break;
    pos += skipLen;
  }
  if (count === 0) return;
  const totalEnc = count * cryptLen;
  const gathered = Buffer.allocUnsafe(totalEnc);
  let w = 0;
  let r = 0;
  for (let i = 0; i < count; i++) {
    data.copy(gathered, w, r, r + cryptLen);
    w += cryptLen;
    r += cryptLen;
    if (i < count - 1) r += skipLen;
  }
  const dec = backend.decrypt(gathered, iv);
  w = 0;
  r = 0;
  for (let i = 0; i < count; i++) {
    dec.copy(data, r, w, w + cryptLen);
    w += cryptLen;
    r += cryptLen;
    if (i < count - 1) r += skipLen;
  }
}

// ----- Public decryptSample -----

export function decryptSample(
  data: Buffer,
  keyOrBackend: Buffer | AesBackend,
  iv: Buffer,
  info: SampleEncryption,
  subsamples?: SegmentSample["subsamples"]
): Buffer {
  const backend = resolveBackend(keyOrBackend);
  const out = Buffer.from(data); // copy

  // Determine IV to use for cbcs
  let effectiveIv: Buffer | null = null;
  if (info.scheme === "cbcs") {
    if (info.constantIv) {
      effectiveIv = info.constantIv;
      if (effectiveIv.length !== 16) {
        const tmp = Buffer.alloc(16, 0);
        effectiveIv.copy(tmp, 0, 0, Math.min(16, effectiveIv.length));
        effectiveIv = tmp;
      }
    } else {
      effectiveIv = iv;
      if (effectiveIv.length === 8) effectiveIv = expandIv8to16(effectiveIv);
    }
    if (!effectiveIv || effectiveIv.length !== 16) throw new Error("cbcs requires 16-byte constant IV");
  } else {
    if (iv.length === 8) effectiveIv = expandIv8to16(iv);
    else if (iv.length === 16) effectiveIv = iv;
    else if (iv.length === 0) throw new Error("cenc requires per-sample IV");
    else throw new Error("invalid IV size for cenc");
  }

  if (info.scheme === "cbcs") {
    const crypt = info.cryptByteBlock;
    const skip = info.skipByteBlock;
    if (subsamples && subsamples.length > 0) {
      let pos = 0;
      for (const ss of subsamples) {
        pos += ss.clear;
        if (ss.encrypted > 0) {
          if (pos + ss.encrypted > out.length) throw new Error("subsample exceeds buffer");
          const slice = out.subarray(pos, pos + ss.encrypted);
          if (crypt === 0 && skip === 0) {
            cbcsDecryptFull(slice as Buffer, backend, effectiveIv!);
          } else {
            cbcsDecryptPattern(slice as Buffer, backend, effectiveIv!, crypt, skip);
          }
          pos += ss.encrypted;
        }
      }
    } else {
      if (crypt === 0 && skip === 0) cbcsDecryptFull(out, backend, effectiveIv!);
      else cbcsDecryptPattern(out, backend, effectiveIv!, crypt, skip);
    }
  } else {
    const ivForRuns = effectiveIv!;
    if (subsamples && subsamples.length > 0) {
      let pos = 0;
      for (const ss of subsamples) {
        pos += ss.clear;
        if (ss.encrypted > 0) {
          if (pos + ss.encrypted > out.length) throw new Error("subsample exceeds buffer");
          const slice = out.subarray(pos, pos + ss.encrypted);
          if (slice.length % 16 !== 0) {
            throw new Error("encrypted run not block aligned");
          }
          if (slice.length === 0) { pos += ss.encrypted; continue; }
          const dec = backend.decrypt(Buffer.from(slice), ivForRuns);
          dec.copy(out, pos);
          pos += ss.encrypted;
        }
      }
    } else {
      if (out.length === 0) return out;
      if (out.length % 16 !== 0) {
        const trunc = out.length & ~0xf;
        if (trunc > 0) {
          const dec = backend.decrypt(Buffer.from(out.subarray(0, trunc)), ivForRuns);
          dec.copy(out, 0);
        }
      } else {
        const dec = backend.decrypt(out, ivForRuns);
        dec.copy(out, 0);
      }
    }
  }
  return out;
}

// ----- Segment parsing helpers -----

function parseTkhdTrackId(buf: Buffer, payloadOffset: number, payloadSize: number): number {
  if (payloadSize < 4) throw new Error("tkhd too small");
  const ver = buf.readUInt8(payloadOffset);
  if (ver === 1) {
    if (payloadSize < 24) throw new Error("tkhd v1 too small");
    return buf.readUInt32BE(payloadOffset + 20);
  } else {
    if (payloadSize < 16) throw new Error("tkhd v0 too small");
    return buf.readUInt32BE(payloadOffset + 12);
  }
}

function parseTfhdTrackId(buf: Buffer, payloadOffset: number): number {
  return buf.readUInt32BE(payloadOffset + 4);
}

interface TrunInfo {
  dataOffset: number | null;
  sampleSizes: number[];
}

function parseTrun(buf: Buffer, box: ReturnType<typeof parseBoxes>[number]): TrunInfo {
  const payloadOffset = box.payloadOffset;
  const flags = box.flags ?? 0;
  const version = box.version ?? 0;
  let off = payloadOffset + 4;
  let dataOffset: number | null = null;
  if (flags & 0x000001) {
    dataOffset = buf.readInt32BE(off);
    off += 4;
  }
  if (flags & 0x000004) {
    off += 4;
  }
  const sampleCount = buf.readUInt32BE(off);
  off += 4;
  const sampleSizes: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    let size = 0;
    let hasSize = false;
    if (flags & 0x000100) {
      off += 4;
    }
    if (flags & 0x000200) {
      size = buf.readUInt32BE(off);
      off += 4;
      hasSize = true;
    }
    if (flags & 0x000400) {
      off += 4;
    }
    if (flags & 0x000800) {
      if (version === 0) off += 4;
      else off += 4;
    }
    if (hasSize) sampleSizes.push(size);
    else {
      throw new Error("trun missing sample size");
    }
    if (off > box.payloadOffset + box.payloadSize) throw new Error("trun overrun");
  }
  return { dataOffset, sampleSizes };
}

interface SencPerSample {
  iv: Buffer | null;
  subsamples: { clear: number; encrypted: number }[] | null;
}

function deduceIvSize(payloadRemainAfterCount: number, sampleCount: number, flags: number, buf: Buffer, payloadStartForSamples: number): number {
  const candidates = [0, 8, 16];
  const subsamplePresent = (flags & 0x02) !== 0;
  if (!subsamplePresent) {
    for (const iv of candidates) {
      if (iv * sampleCount === payloadRemainAfterCount) return iv;
    }
    if (payloadRemainAfterCount === 0) return 0;
    throw new Error(`cannot deduce IV size: payloadRemain ${payloadRemainAfterCount} count ${sampleCount}`);
  } else {
    for (const iv of candidates) {
      let off = payloadStartForSamples;
      let ok = true;
      for (let i = 0; i < sampleCount; i++) {
        if (off + iv + 2 > payloadStartForSamples + payloadRemainAfterCount) { ok = false; break; }
        off += iv;
        const cnt = buf.readUInt16BE(off);
        off += 2;
        if (off + cnt * 6 > payloadStartForSamples + payloadRemainAfterCount) { ok = false; break; }
        off += cnt * 6;
      }
      if (ok && off === payloadStartForSamples + payloadRemainAfterCount) return iv;
    }
    throw new Error("cannot deduce IV size with subsamples");
  }
}

function parseSencBox(buf: Buffer, box: ReturnType<typeof parseBoxes>[number]): SencPerSample[] {
  const version = box.version ?? 0;
  void version;
  const flags = box.flags ?? 0;
  const payloadOffset = box.payloadOffset;
  if (box.payloadSize < 8) throw new Error("senc too small");
  const sampleCount = buf.readUInt32BE(payloadOffset + 4);
  const payloadRemainTotal = box.payloadSize - 8;
  const samplesStart = payloadOffset + 8;
  const ivSize = deduceIvSize(payloadRemainTotal, sampleCount, flags, buf, samplesStart);

  const out: SencPerSample[] = [];
  let off = samplesStart;
  for (let i = 0; i < sampleCount; i++) {
    let iv: Buffer | null = null;
    if (ivSize > 0) {
      iv = Buffer.from(buf.subarray(off, off + ivSize));
      off += ivSize;
    }
    let subs: { clear: number; encrypted: number }[] | null = null;
    if (flags & 0x02) {
      if (off + 2 > samplesStart + payloadRemainTotal) throw new Error("senc subsample count truncated");
      const subsCount = buf.readUInt16BE(off);
      off += 2;
      subs = [];
      for (let j = 0; j < subsCount; j++) {
        if (off + 6 > samplesStart + payloadRemainTotal) throw new Error("senc subsample entry truncated");
        const clear = buf.readUInt16BE(off);
        const enc = buf.readUInt32BE(off + 2);
        off += 6;
        subs.push({ clear, encrypted: enc });
      }
    }
    out.push({ iv, subsamples: subs });
  }
  if (off !== samplesStart + payloadRemainTotal) throw new Error("senc parsing leftover bytes");
  return out;
}

// Segment parse top-level

export function parseSegment(segment: Buffer): { trackId: number; samples: SegmentSample[] } {
  if (!Buffer.isBuffer(segment)) throw new Error("segment must be Buffer");
  if (segment.length < 8) throw new Error("segment too small");
  const top = parseBoxes(segment, 0, segment.length);
  const samples: SegmentSample[] = [];
  let trackId: number | null = null;

  let idx = 0;
  while (idx < top.length) {
    const b = top[idx];
    if (!b) { idx++; continue; }
    if (b.type === "moof") {
      const moofChildren = parseBoxes(segment, b.payloadOffset, b.payloadOffset + b.payloadSize);
      const trafs = moofChildren.filter((c) => c.type === "traf");
      if (trafs.length === 0) throw new Error("moof without traf");
      for (const traf of trafs) {
        const trafChildren = parseBoxes(segment, traf.payloadOffset, traf.payloadOffset + traf.payloadSize);
        const tfhd = trafChildren.find((c) => c.type === "tfhd");
        if (!tfhd) throw new Error("traf missing tfhd");
        const curTrackId = parseTfhdTrackId(segment, tfhd.payloadOffset);
        if (trackId === null) trackId = curTrackId;
        const truns = trafChildren.filter((c) => c.type === "trun");
        if (truns.length === 0) throw new Error("traf missing trun");
        const allSizes: number[] = [];
        for (const tr of truns) {
          const info = parseTrun(segment, tr);
          allSizes.push(...info.sampleSizes);
        }
        let sencInfo: SencPerSample[] | null = null;
        const sencBox = trafChildren.find((c) => c.type === "senc");
        let sencAlternative: ReturnType<typeof parseBoxes>[number] | null = null;
        if (!sencBox) {
          const uuidBoxes = trafChildren.filter((c) => c.type === "uuid");
          if (uuidBoxes.length > 0) sencAlternative = uuidBoxes[0] ?? null;
        }
        let activeSencBox = sencBox ?? sencAlternative;
        if (activeSencBox) {
          sencInfo = parseSencBox(segment, activeSencBox);
          if (sencInfo.length !== allSizes.length) {
            throw new Error(`senc sample count ${sencInfo.length} != trun count ${allSizes.length}`);
          }
        }

        const nextMdat = (() => {
          for (let k = idx + 1; k < top.length; k++) {
            const nb = top[k];
            if (nb && nb.type === "mdat") return nb;
            if (nb && nb.type === "moof") break;
          }
          return null;
        })();
        if (!nextMdat) throw new Error("moof without following mdat");

        const mdatPayloadOffset = nextMdat.payloadOffset;
        let cum = 0;
        for (let i = 0; i < allSizes.length; i++) {
          const sz = allSizes[i]!;
          const offset = mdatPayloadOffset + cum;
          if (offset + sz > nextMdat.payloadOffset + nextMdat.payloadSize) throw new Error("sample exceeds mdat");
          const per = sencInfo ? sencInfo[i] ?? null : null;
          samples.push({
            offset,
            size: sz,
            iv: per ? per.iv : null,
            subsamples: per ? per.subsamples : null,
          });
          cum += sz;
        }
      }
    }
    idx++;
  }

  if (trackId === null) throw new Error("no trackId found in segment");
  if (samples.length === 0) throw new Error("no samples found");
  return { trackId, samples };
}

// Helpers for decryptSegment rebuilding

function isSeamSeig(buf: Buffer, box: ReturnType<typeof parseBoxes>[number]): boolean {
  if (box.type !== "sbgp" && box.type !== "sgpd") return false;
  if (box.payloadSize < 8) return false;
  const grouping = buf.toString("ascii", box.payloadOffset + 4, box.payloadOffset + 8);
  return grouping === "seam" || grouping === "seig";
}

function shouldRemoveTrafBox(buf: Buffer, box: ReturnType<typeof parseBoxes>[number]): boolean {
  if (box.type === "senc" || box.type === "saiz" || box.type === "saio") return true;
  if (box.type === "uuid") {
    return false;
  }
  if (isSeamSeig(buf, box)) return true;
  return false;
}

function rebuildTrafWithAdjust(
  buf: Buffer,
  traf: ReturnType<typeof parseBoxes>[number],
  bytesRemovedForMoof: number
): Buffer {
  const children = parseBoxes(buf, traf.payloadOffset, traf.payloadOffset + traf.payloadSize);
  const kept: Buffer[] = [];
  for (const c of children) {
    if (shouldRemoveTrafBox(buf, c)) continue;
    if (c.type === "trun" && bytesRemovedForMoof !== 0) {
      const flags = c.flags ?? 0;
      if (flags & 0x000001) {
        const trunData = Buffer.from(buf.subarray(c.offset, c.offset + c.size));
        const original = trunData.readInt32BE(c.payloadOffset - c.offset + 4);
        const patched = original - bytesRemovedForMoof;
        trunData.writeInt32BE(patched, c.payloadOffset - c.offset + 4);
        kept.push(trunData);
      } else {
        kept.push(Buffer.from(buf.subarray(c.offset, c.offset + c.size)));
      }
    } else {
      kept.push(Buffer.from(buf.subarray(c.offset, c.offset + c.size)));
    }
  }
  return makeBox("traf", Buffer.concat(kept));
}

function buildDecryptedSegmentInternal(
  segment: Buffer,
  backend: AesBackend,
  info: SampleEncryption,
  doDecrypt: boolean
): Buffer {
  const top = parseBoxes(segment, 0, segment.length);
  const moofInfos: Array<{
    moof: ReturnType<typeof parseBoxes>[number];
    trafBoxes: ReturnType<typeof parseBoxes>[number][];
    bytesRemoved: number;
    rebuiltMoof: Buffer;
    mdat: ReturnType<typeof parseBoxes>[number] | null;
    samples: Array<{ offsetInMdat: number; size: number; iv: Buffer | null; subs: { clear: number; encrypted: number }[] | null }>;
  }> = [];

  for (let i = 0; i < top.length; i++) {
    const b = top[i];
    if (!b || b.type !== "moof") continue;
    const moofChildren = parseBoxes(segment, b.payloadOffset, b.payloadOffset + b.payloadSize);
    const trafs = moofChildren.filter((c) => c.type === "traf");
    let totalRemoved = 0;
    for (const traf of trafs) {
      const trafChildren = parseBoxes(segment, traf.payloadOffset, traf.payloadOffset + traf.payloadSize);
      for (const c of trafChildren) {
        if (shouldRemoveTrafBox(segment, c)) totalRemoved += c.size;
      }
    }
    const psshs = moofChildren.filter((c) => c.type === "pssh");
    for (const p of psshs) totalRemoved += p.size;

    let nextMdat: ReturnType<typeof parseBoxes>[number] | null = null;
    for (let k = i + 1; k < top.length; k++) {
      const nb = top[k];
      if (!nb) continue;
      if (nb.type === "mdat") { nextMdat = nb; break; }
      if (nb.type === "moof") break;
    }

    const samplesForMoof: Array<{ offsetInMdat: number; size: number; iv: Buffer | null; subs: { clear: number; encrypted: number }[] | null }> = [];
    for (const traf of trafs) {
      const trafChildren = parseBoxes(segment, traf.payloadOffset, traf.payloadOffset + traf.payloadSize);
      const truns = trafChildren.filter((c) => c.type === "trun");
      const sizes: number[] = [];
      for (const tr of truns) sizes.push(...parseTrun(segment, tr).sampleSizes);
      const sencBox = trafChildren.find((c) => c.type === "senc");
      let sencParsed: SencPerSample[] | null = null;
      if (sencBox) {
        sencParsed = parseSencBox(segment, sencBox);
      } else {
        const uuidBoxes = trafChildren.filter((c) => c.type === "uuid");
        if (uuidBoxes.length > 0) {
          try { sencParsed = parseSencBox(segment, uuidBoxes[0]!); } catch { sencParsed = null; }
        }
      }
      let cum = 0;
      let baseCumPrevTrafs = 0;
      for (const prevTraf of trafs) {
        if (prevTraf === traf) break;
        const prevChildren = parseBoxes(segment, prevTraf.payloadOffset, prevTraf.payloadOffset + prevTraf.payloadSize);
        const prevTruns = prevChildren.filter((c) => c.type === "trun");
        for (const pt of prevTruns) baseCumPrevTrafs += parseTrun(segment, pt).sampleSizes.reduce((a,b)=>a+b,0);
      }
      for (let si = 0; si < sizes.length; si++) {
        const offInMdat = baseCumPrevTrafs + cum;
        const per = sencParsed ? sencParsed[si] ?? null : null;
        samplesForMoof.push({ offsetInMdat: offInMdat, size: sizes[si]!, iv: per ? per.iv : null, subs: per ? per.subsamples : null });
        cum += sizes[si]!;
      }
    }

    const keptMoofChildren: Buffer[] = [];
    for (const c of moofChildren) {
      if (c.type === "pssh") continue;
      if (c.type === "traf") {
        keptMoofChildren.push(rebuildTrafWithAdjust(segment, c, totalRemoved));
      } else {
        keptMoofChildren.push(Buffer.from(segment.subarray(c.offset, c.offset + c.size)));
      }
    }
    const rebuiltMoof = makeBox("moof", Buffer.concat(keptMoofChildren));

    moofInfos.push({ moof: b, trafBoxes: trafs, bytesRemoved: totalRemoved, rebuiltMoof, mdat: nextMdat, samples: samplesForMoof });
  }

  const outParts: Buffer[] = [];
  const moofIdxMap = new Map<number, number>();
  for (let i = 0; i < moofInfos.length; i++) {
    const mi = moofInfos[i]!;
    const topIdx = top.findIndex((b) => b.offset === mi.moof.offset);
    if (topIdx >=0) moofIdxMap.set(topIdx, i);
  }
  const handledMdat = new Set<number>();
  for (let ti = 0; ti < top.length; ti++) {
    const b = top[ti]!;
    if (b.type === "moof") {
      const miIdx = moofIdxMap.get(ti);
      if (miIdx !== undefined) outParts.push(moofInfos[miIdx]!.rebuiltMoof);
      else outParts.push(Buffer.from(segment.subarray(b.offset, b.offset + b.size)));
    } else if (b.type === "mdat") {
      if (handledMdat.has(ti)) continue;
      const owner = moofInfos.find((mi) => mi.mdat && mi.mdat.offset === b.offset);
      if (owner) {
        const payload = Buffer.from(segment.subarray(b.payloadOffset, b.payloadOffset + b.payloadSize));
        if (doDecrypt) {
          for (const s of owner.samples) {
            const slice = payload.subarray(s.offsetInMdat, s.offsetInMdat + s.size);
            let iv: Buffer;
            if (info.scheme === "cbcs") {
              if (info.constantIv) iv = info.constantIv;
              else if (s.iv) iv = s.iv;
              else throw new Error("cbcs missing IV");
            } else {
              if (!s.iv) throw new Error("cenc missing per-sample IV");
              iv = s.iv;
            }
            const decrypted = decryptSample(Buffer.from(slice), backend, iv, info, s.subs ?? undefined);
            decrypted.copy(payload, s.offsetInMdat);
          }
        }
        outParts.push(makeBox("mdat", payload));
        handledMdat.add(ti);
      } else {
        outParts.push(Buffer.from(segment.subarray(b.offset, b.offset + b.size)));
      }
    } else {
      outParts.push(Buffer.from(segment.subarray(b.offset, b.offset + b.size)));
    }
  }

  return Buffer.concat(outParts);
}

export function decryptSegment(
  segment: Buffer,
  keyOrBackend: Buffer | AesBackend,
  info: SampleEncryption | InitInfo
): Buffer {
  const backend = resolveBackend(keyOrBackend);
  const enc = normalizeInfo(info);
  parseSegment(segment);
  return buildDecryptedSegmentInternal(segment, backend, enc, true);
}
