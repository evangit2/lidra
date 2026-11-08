import { parseBoxes, makeBox, makeFullBox } from "./box";
import type { InitInfo, SampleEncryption } from "./types";

function findEncryptedTrack(
  buf: Buffer
): {
  trakBox: ReturnType<typeof parseBoxes>[number];
  trakPayload: { start: number; end: number };
  tkhdTrackId: number;
  stsdBox: ReturnType<typeof parseBoxes>[number];
  encaBox: ReturnType<typeof parseBoxes>[number];
  sinfBox: ReturnType<typeof parseBoxes>[number];
  frmaBox: ReturnType<typeof parseBoxes>[number];
  schmBox: ReturnType<typeof parseBoxes>[number];
  tencBox: ReturnType<typeof parseBoxes>[number];
} | null {
  const top = parseBoxes(buf, 0, buf.length);
  const moovCandidates = top.filter((b) => b.type === "moov");
  if (moovCandidates.length === 0) throw new Error("no moov box found");
  // Use first moov
  const moov = moovCandidates[0];
  if (!moov) throw new Error("no moov");
  const moovChildren = parseBoxes(buf, moov.payloadOffset, moov.payloadOffset + moov.payloadSize);
  const traks = moovChildren.filter((b) => b.type === "trak");
  if (traks.length === 0) throw new Error("no trak found inside moov");

  let found: ReturnType<typeof findEncryptedTrack> | null = null;

  for (const trak of traks) {
    const trakChildren = parseBoxes(buf, trak.payloadOffset, trak.payloadOffset + trak.payloadSize);
    const tkhd = trakChildren.find((b) => b.type === "tkhd");
    if (!tkhd) continue;
    // parse track_id from tkhd
    const tkhdVersion = buf.readUInt8(tkhd.payloadOffset);
    let trackId: number;
    if (tkhdVersion === 1) {
      trackId = buf.readUInt32BE(tkhd.payloadOffset + 20);
    } else {
      trackId = buf.readUInt32BE(tkhd.payloadOffset + 12);
    }

    const mdia = trakChildren.find((b) => b.type === "mdia");
    if (!mdia) continue;
    const mdiaChildren = parseBoxes(buf, mdia.payloadOffset, mdia.payloadOffset + mdia.payloadSize);
    const minf = mdiaChildren.find((b) => b.type === "minf");
    if (!minf) continue;
    const minfChildren = parseBoxes(buf, minf.payloadOffset, minf.payloadOffset + minf.payloadSize);
    const stbl = minfChildren.find((b) => b.type === "stbl");
    if (!stbl) continue;
    const stblChildren = parseBoxes(buf, stbl.payloadOffset, stbl.payloadOffset + stbl.payloadSize);
    const stsd = stblChildren.find((b) => b.type === "stsd");
    if (!stsd) continue;
    // stsd payload: version/flags 4 + entry_count 4 then entries
    if (stsd.payloadSize < 8) continue;
    const entryCount = buf.readUInt32BE(stsd.payloadOffset + 4);
    if (entryCount === 0) continue;
    const entriesStart = stsd.payloadOffset + 8;
    const entriesEnd = stsd.payloadOffset + stsd.payloadSize;
    let entries: ReturnType<typeof parseBoxes>;
    try {
      entries = parseBoxes(buf, entriesStart, entriesEnd);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // entry type like enca, encv, etc
      if (entry.type !== "enca" && entry.type !== "encv" && entry.type !== "encs" && entry.type !== "enct") {
        continue;
      }
      // Search sinf inside entry payload after sample entry fields.
      // We will parse all children inside entry payload - sample entry fields are before first child box.
      // Our parseBoxes will treat the whole payload as boxes, but the leading sample entry fields (28 bytes for enca) are not boxes.
      // So we need to skip those fields.
      // For audio sample entry (enca): 28 bytes header before boxes. For visual encv: 78 bytes etc.
      // To be robust, scan payload for sinf box by searching raw pattern.
      const entryPayloadStart = entry.payloadOffset;
      const entryPayloadEnd = entry.payloadOffset + entry.payloadSize;
      // Try to locate sinf by scanning boxes with brute force offset sliding.
      // Since parseBoxes expects boxes aligned at start, we will attempt to find first box offset where type == "sinf".
      let sinf: ReturnType<typeof parseBoxes>[number] | null = null;
      let scan = entryPayloadStart;
      // The sample entry header size differs per type, but we can attempt to scan byte by byte for box start that parses.
      // Instead we use heuristic: for enca, entries start at offset +28 from entry payload.
      const headerSkipByType: Record<string, number> = {
        enca: 28,
        encv: 78,
        encs: 8,
        enct: 8,
      };
      const skip = headerSkipByType[entry.type] ?? 8;
      let childBoxesStart = entryPayloadStart + skip;
      // If skip would be beyond bounds, try scan approach
      if (childBoxesStart >= entryPayloadEnd) {
        // fallback scan
        childBoxesStart = entryPayloadStart;
        // find sinf by brute search for box type at aligned offset
        let found = false;
        for (let p = entryPayloadStart; p + 8 <= entryPayloadEnd; p++) {
          const sz = buf.readUInt32BE(p);
          if (sz < 8 || p + sz > entryPayloadEnd) continue;
          const t = buf.toString("ascii", p + 4, p + 8);
          if (t === "sinf") {
            childBoxesStart = p;
            found = true;
            break;
          }
        }
        if (!found) continue;
      }
      try {
        const childBoxes = parseBoxes(buf, childBoxesStart, entryPayloadEnd);
        const s = childBoxes.find((b) => b.type === "sinf");
        if (!s) continue;
        sinf = s;
      } catch {
        continue;
      }
      if (!sinf) continue;
      // Found encrypted entry
      const sinfChildren = parseBoxes(buf, sinf.payloadOffset, sinf.payloadOffset + sinf.payloadSize);
      const frma = sinfChildren.find((b) => b.type === "frma");
      const schm = sinfChildren.find((b) => b.type === "schm");
      const schi = sinfChildren.find((b) => b.type === "schi");
      if (!frma || !schm || !schi) continue;
      const schiChildren = parseBoxes(buf, schi.payloadOffset, schi.payloadOffset + schi.payloadSize);
      const tenc = schiChildren.find((b) => b.type === "tenc");
      if (!tenc) continue;
      found = {
        trakBox: trak,
        trakPayload: { start: trak.payloadOffset, end: trak.payloadOffset + trak.payloadSize },
        tkhdTrackId: trackId,
        stsdBox: stsd,
        encaBox: entry,
        sinfBox: sinf,
        frmaBox: frma,
        schmBox: schm,
        tencBox: tenc,
      };
      break;
    }
    if (found) break;
  }
  return found;
}

function parseTenc(buf: Buffer, tenc: ReturnType<typeof parseBoxes>[number]): {
  perSampleIvSize: number;
  kid: Buffer;
  constantIv: Buffer | null;
  crypt: number;
  skip: number;
} {
  // ISO/IEC 23001-7 layout, byte for byte:
  //   reserved(8) [ version 1: crypt(4)|skip(4) ] isProtected(8)
  //   perSampleIvSize(8) KID(16)
  //   [ isProtected && perSampleIvSize == 0: constantIvSize(8) constantIv[...] ]
  const start = tenc.payloadOffset;
  const end = tenc.payloadOffset + tenc.payloadSize;
  // v0 minimum: version/flags(4) reserved(1) isProtected(1) ivSize(1) KID(16)
  if (tenc.payloadSize < 4 + 19) throw new Error("tenc box too small");
  const version = buf.readUInt8(start);
  let off = start + 4; // version + flags

  off += 1; // reserved
  let crypt = 0;
  let skip = 0;
  if (version >= 1) {
    const pattern = buf.readUInt8(off);
    crypt = (pattern >> 4) & 0x0f;
    skip = pattern & 0x0f;
    off += 1;
  }
  const isProtected = buf.readUInt8(off);
  off += 1;
  const perSampleIvSize = buf.readUInt8(off);
  off += 1;
  if (off + 16 > end) throw new Error("tenc missing default_KID");
  const kid = Buffer.from(buf.subarray(off, off + 16));
  off += 16;

  let constantIv: Buffer | null = null;
  if (isProtected === 1 && perSampleIvSize === 0 && off < end) {
    const size = buf.readUInt8(off);
    off += 1;
    if (size > 0) {
      if (off + size > end) throw new Error("tenc constant IV truncated");
      constantIv = Buffer.from(buf.subarray(off, off + size));
      off += size;
    }
  }

  return { perSampleIvSize, kid, constantIv, crypt, skip };
}

function parseSchemeType(buf: Buffer, schm: ReturnType<typeof parseBoxes>[number]): string {
  if (schm.payloadSize < 4) throw new Error("schm too small");
  const version = buf.readUInt8(schm.payloadOffset);
  // flags 3 bytes
  // After that scheme_type 4, scheme_version 4 maybe
  // schm fullbox: version 0/1? payload after header: scheme_type(4) scheme_version(4) [optional scheme_uri length-prefixed]
  // Our builder uses version 0 flags 0, scheme_type at offset 4
  const off = schm.payloadOffset + 4;
  if (off + 4 > schm.payloadOffset + schm.payloadSize) throw new Error("schm missing scheme_type");
  const scheme = buf.toString("ascii", off, off + 4);
  return scheme;
}

function parseOriginalFormat(buf: Buffer, frma: ReturnType<typeof parseBoxes>[number]): string {
  if (frma.payloadSize < 4) throw new Error("frma too small");
  // frma payload is 4 bytes original format (non-fullbox)
  return buf.toString("ascii", frma.payloadOffset, frma.payloadOffset + 4);
}

export function parseInit(init: Buffer): InitInfo {
  if (!Buffer.isBuffer(init)) throw new Error("init must be a Buffer");
  if (init.length < 8) throw new Error("init buffer too small");
  const found = findEncryptedTrack(init);
  if (!found) throw new Error("no encrypted track found (sinf/tenc missing)");
  const schemeType = parseSchemeType(init, found.schmBox);
  const allowed = new Set(["cbcs", "cenc", "cbc1"]);
  if (!allowed.has(schemeType)) throw new Error(`unsupported scheme ${schemeType}`);
  const tencInfo = parseTenc(init, found.tencBox);
  const orig = parseOriginalFormat(init, found.frmaBox);

  const encryption: SampleEncryption = {
    scheme: schemeType as SampleEncryption["scheme"],
    defaultKid: tencInfo.kid,
    perSampleIvSize: tencInfo.perSampleIvSize,
    constantIv: tencInfo.constantIv,
    cryptByteBlock: tencInfo.crypt,
    skipByteBlock: tencInfo.skip,
    originalFormat: orig,
  };
  return { trackId: found.tkhdTrackId, encryption };
}

// ---------- rewrite helpers ----------

function isSeamSeigBox(buf: Buffer, box: ReturnType<typeof parseBoxes>[number]): boolean {
  if (box.type !== "sbgp" && box.type !== "sgpd") return false;
  if (box.payloadSize < 8) return false;
  // fullbox: version(1) flags(3) + grouping_type(4)
  const grouping = buf.toString("ascii", box.payloadOffset + 4, box.payloadOffset + 8);
  return grouping === "seam" || grouping === "seig";
}

function removeEvilStblChildren(buf: Buffer, stblPayloadStart: number, stblPayloadEnd: number, originalFormat: string, encaBox: ReturnType<typeof parseBoxes>[number], stsdBox: ReturnType<typeof parseBoxes>[number]): Buffer {
  // Need to rebuild stbl payload without sbgp/sgpd(seam|seig) and with enca renamed.
  const children = parseBoxes(buf, stblPayloadStart, stblPayloadEnd);
  const rebuilt: Buffer[] = [];
  for (const child of children) {
    if (isSeamSeigBox(buf, child)) {
      continue;
    }
    if (child.type === "stsd") {
      // Rebuild stsd: rename enca etc
      rebuilt.push(rebuildStsd(buf, child, originalFormat));
    } else {
      // copy raw
      rebuilt.push(Buffer.from(buf.subarray(child.offset, child.offset + child.size)));
    }
  }
  return Buffer.concat(rebuilt);
}

function rebuildStsd(buf: Buffer, stsd: ReturnType<typeof parseBoxes>[number], originalFormat: string): Buffer {
  // stsd payload: version/flags 4 + entry_count 4 + entries
  const header = Buffer.from(buf.subarray(stsd.payloadOffset, stsd.payloadOffset + 8));
  const entriesStart = stsd.payloadOffset + 8;
  const entriesEnd = stsd.payloadOffset + stsd.payloadSize;
  const entries = parseBoxes(buf, entriesStart, entriesEnd);
  const newEntries: Buffer[] = [];
  for (const entry of entries) {
    if (entry.type === "enca" || entry.type === "encv" || entry.type === "encs") {
      // Need to rename to originalFormat and strip sinf.
      const renamed = rebuildSampleEntry(buf, entry, originalFormat);
      newEntries.push(renamed);
    } else {
      newEntries.push(Buffer.from(buf.subarray(entry.offset, entry.offset + entry.size)));
    }
  }
  const payload = Buffer.concat([header, Buffer.concat(newEntries)]);
  const flags = (payload.readUInt8(1)<<16)|(payload.readUInt8(2)<<8)|payload.readUInt8(3);
  const version = payload.readUInt8(0);
  return makeFullBox("stsd", version, flags, payload.subarray(4));
}

function rebuildSampleEntry(buf: Buffer, entry: ReturnType<typeof parseBoxes>[number], originalFormat: string): Buffer {
  // entry.payload includes sample entry fields + maybe sinf
  const headerSkipByType: Record<string, number> = {
    enca: 28,
    encv: 78,
    encs: 8,
  };
  const skip = headerSkipByType[entry.type] ?? 8;
  const entryPayloadStart = entry.payloadOffset;
  const entryPayloadEnd = entry.payloadOffset + entry.payloadSize;
  let childBoxesStart = entryPayloadStart + skip;
  if (childBoxesStart > entryPayloadEnd) childBoxesStart = entryPayloadEnd;

  // Validate that childBoxesStart is plausible: ensure first child size plausible
  if (childBoxesStart < entryPayloadEnd) {
    const possibleSize = buf.readUInt32BE(childBoxesStart);
    if (possibleSize < 8 || childBoxesStart + possibleSize > entryPayloadEnd) {
      // Try brute scan for sinf
      for (let p = entryPayloadStart; p + 8 <= entryPayloadEnd; p++) {
        const sz = buf.readUInt32BE(p);
        if (sz < 8 || p + sz > entryPayloadEnd) continue;
        const t = buf.toString("ascii", p+4, p+8);
        if (t === "sinf") { childBoxesStart = p; break; }
      }
    }
  }

  const fields = Buffer.from(buf.subarray(entryPayloadStart, Math.min(childBoxesStart, entryPayloadEnd)));

  let filteredChildBytes = Buffer.alloc(0);
  if (childBoxesStart < entryPayloadEnd) {
    try {
      const childs = parseBoxes(buf, childBoxesStart, entryPayloadEnd);
      const keep: Buffer[] = [];
      for (const c of childs) {
        if (c.type === "sinf") continue;
        keep.push(Buffer.from(buf.subarray(c.offset, c.offset + c.size)));
      }
      filteredChildBytes = Buffer.concat(keep);
    } catch {
      // If parsing fails, keep nothing beyond fields
      filteredChildBytes = Buffer.alloc(0);
    }
  }
  const newPayload = Buffer.concat([fields, filteredChildBytes]);
  // Build new box with renamed type
  return makeBox(originalFormat, newPayload);
}

// Generic recursive box rewriter for init.

function rewriteTrak(
  buf: Buffer,
  trak: ReturnType<typeof parseBoxes>[number],
  originalFormat: string
): Buffer {
  const children = parseBoxes(buf, trak.payloadOffset, trak.payloadOffset + trak.payloadSize);
  const rebuiltChildren: Buffer[] = [];
  for (const child of children) {
    if (child.type === "mdia") {
      rebuiltChildren.push(rewriteMdia(buf, child, originalFormat));
    } else {
      rebuiltChildren.push(Buffer.from(buf.subarray(child.offset, child.offset + child.size)));
    }
  }
  return makeBox("trak", Buffer.concat(rebuiltChildren));
}

function rewriteMdia(buf: Buffer, mdia: ReturnType<typeof parseBoxes>[number], originalFormat: string): Buffer {
  const children = parseBoxes(buf, mdia.payloadOffset, mdia.payloadOffset + mdia.payloadSize);
  const rebuilt: Buffer[] = [];
  for (const c of children) {
    if (c.type === "minf") rebuilt.push(rewriteMinf(buf, c, originalFormat));
    else rebuilt.push(Buffer.from(buf.subarray(c.offset, c.offset + c.size)));
  }
  return makeBox("mdia", Buffer.concat(rebuilt));
}

function rewriteMinf(buf: Buffer, minf: ReturnType<typeof parseBoxes>[number], originalFormat: string): Buffer {
  const children = parseBoxes(buf, minf.payloadOffset, minf.payloadOffset + minf.payloadSize);
  const rebuilt: Buffer[] = [];
  for (const c of children) {
    if (c.type === "stbl") rebuilt.push(rewriteStbl(buf, c, originalFormat));
    else rebuilt.push(Buffer.from(buf.subarray(c.offset, c.offset + c.size)));
  }
  return makeBox("minf", Buffer.concat(rebuilt));
}

function rewriteStbl(buf: Buffer, stbl: ReturnType<typeof parseBoxes>[number], originalFormat: string): Buffer {
  const children = parseBoxes(buf, stbl.payloadOffset, stbl.payloadOffset + stbl.payloadSize);
  const rebuilt: Buffer[] = [];
  for (const c of children) {
    if (isSeamSeigBox(buf, c)) continue;
    if (c.type === "stsd") {
      rebuilt.push(rebuildStsd(buf, c, originalFormat));
    } else {
      rebuilt.push(Buffer.from(buf.subarray(c.offset, c.offset + c.size)));
    }
  }
  return makeBox("stbl", Buffer.concat(rebuilt));
}

function rewriteMoov(buf: Buffer, moov: ReturnType<typeof parseBoxes>[number], originalFormat: string): Buffer {
  const children = parseBoxes(buf, moov.payloadOffset, moov.payloadOffset + moov.payloadSize);
  const rebuilt: Buffer[] = [];
  for (const c of children) {
    if (c.type === "trak") rebuilt.push(rewriteTrak(buf, c, originalFormat));
    else rebuilt.push(Buffer.from(buf.subarray(c.offset, c.offset + c.size)));
  }
  return makeBox("moov", Buffer.concat(rebuilt));
}

export function rewriteInit(init: Buffer): { init: Buffer; info: InitInfo } {
  const info = parseInit(init);
  const top = parseBoxes(init, 0, init.length);
  const outParts: Buffer[] = [];
  for (const b of top) {
    if (b.type === "moov") {
      outParts.push(rewriteMoov(init, b, info.encryption.originalFormat));
    } else {
      // keep other boxes byte-identical (ftyp, etc)
      outParts.push(Buffer.from(init.subarray(b.offset, b.offset + b.size)));
    }
  }
  return { init: Buffer.concat(outParts), info };
}
