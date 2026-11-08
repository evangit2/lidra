export interface BoxInfo {
  offset: number;
  size: number;
  type: string;
  headerSize: number;
  payloadOffset: number;
  payloadSize: number;
  isFullBox: boolean;
  version?: number;
  flags?: number;
}

function readU32(buf: Buffer, off: number): number {
  return buf.readUInt32BE(off);
}
function writeU32(buf: Buffer, off: number, v: number): void {
  buf.writeUInt32BE(v, off);
}
function readU64(buf: Buffer, off: number): bigint {
  const hi = BigInt(buf.readUInt32BE(off));
  const lo = BigInt(buf.readUInt32BE(off + 4));
  return (hi << 32n) | lo;
}

const FULLBOX_TYPES = new Set([
  "mvhd",
  "tkhd",
  "mdhd",
  "hdlr",
  "stsd",
  "sbgp",
  "sgpd",
  "frma",
  "schm",
  "tenc",
  "mfhd",
  "tfhd",
  "tfdt",
  "trun",
  "senc",
  "saiz",
  "saio",
  "sdtp",
]);

export function isFullBoxType(t: string): boolean {
  return FULLBOX_TYPES.has(t);
}

export function parseBoxes(
  buf: Buffer,
  start: number,
  end: number
): BoxInfo[] {
  const out: BoxInfo[] = [];
  let off = start;
  while (off + 8 <= end) {
    const rawSize = readU32(buf, off);
    const type = buf.toString("ascii", off + 4, off + 8);

    if (rawSize < 8 && rawSize !== 0 && rawSize !== 1) {
      throw new Error(
        `malformed box at offset ${off}: size ${rawSize} < 8 for type ${type}`
      );
    }

    let headerSize = 8;
    let size = rawSize;

    if (rawSize === 1) {
      if (off + 16 > end) {
        throw new Error(`malformed largesize box at offset ${off}: truncated`);
      }
      const largesize = readU64(buf, off + 8);
      if (largesize < 16n) {
        throw new Error(`malformed largesize ${largesize} at offset ${off}`);
      }
      if (largesize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`box too large at offset ${off}`);
      }
      size = Number(largesize);
      headerSize = 16;
    } else if (rawSize === 0) {
      size = end - off;
    }

    if (off + size > end) {
      throw new Error(
        `box at offset ${off} type ${type} size ${size} exceeds parent bounds ${end - off}`
      );
    }

    if (type === "uuid") {
      if (size < headerSize + 16) {
        throw new Error(`uuid box too small at offset ${off}`);
      }
      headerSize += 16;
    }

    const payloadOffset = off + headerSize;
    const payloadSize = size - headerSize;
    if (payloadSize < 0) {
      throw new Error(`negative payload at offset ${off}`);
    }

    let version: number | undefined;
    let flags: number | undefined;
    if (isFullBoxType(type) || payloadSize >= 4) {
      // Detect fullbox by type; to be robust we peek version/flags for known types even if unknown,
      // but only mark as fullbox if type in set.
      if (FULLBOX_TYPES.has(type)) {
        if (payloadSize < 4) {
          throw new Error(`fullbox ${type} payload too small at offset ${off}`);
        }
        version = buf.readUInt8(payloadOffset);
        flags = (buf.readUInt8(payloadOffset + 1) << 16) |
                (buf.readUInt8(payloadOffset + 2) << 8) |
                 buf.readUInt8(payloadOffset + 3);
      }
    }

    out.push({
      offset: off,
      size,
      type,
      headerSize,
      payloadOffset,
      payloadSize,
      isFullBox: version !== undefined,
      version,
      flags,
    });

    off += size;
    if (size === 0) break;
  }
  if (off !== end) {
    // Allow trailing zero? But strict: if we have leftover bytes <8 it's malformed.
    if (end - off !== 0) {
      throw new Error(
        `trailing bytes ${end - off} after boxes at offset ${off}`
      );
    }
  }
  return out;
}

export function makeBox(type: string, payload: Buffer): Buffer {
  if (type.length !== 4) throw new Error(`type must be 4 chars: ${type}`);
  const out = Buffer.allocUnsafe(8 + payload.length);
  out.writeUInt32BE(8 + payload.length, 0);
  out.write(type, 4, 4, "ascii");
  payload.copy(out, 8);
  return out;
}

export function makeFullBox(
  type: string,
  version: number,
  flags: number,
  payload: Buffer
): Buffer {
  const hdr = Buffer.allocUnsafe(4);
  hdr.writeUInt8(version, 0);
  hdr.writeUInt8((flags >> 16) & 0xff, 1);
  hdr.writeUInt8((flags >> 8) & 0xff, 2);
  hdr.writeUInt8(flags & 0xff, 3);
  return makeBox(type, Buffer.concat([hdr, payload]));
}

export function makeBoxWithLargesize(type: string, payload: Buffer): Buffer {
  // For completeness, not needed in tests but parser handles it
  const header = Buffer.allocUnsafe(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 4, "ascii");
  const sz = BigInt(16 + payload.length);
  header.writeUInt32BE(Number(sz >> 32n), 8);
  header.writeUInt32BE(Number(sz & 0xffffffffn), 12);
  return Buffer.concat([header, payload]);
}

export function concatBoxes(boxes: Buffer[]): Buffer {
  return Buffer.concat(boxes);
}

export function findBoxes(
  buf: Buffer,
  parentOffset: number,
  parentEnd: number,
  type: string
): BoxInfo[] {
  return parseBoxes(buf, parentOffset, parentEnd).filter((b) => b.type === type);
}

export function getChildPayload(
  buf: Buffer,
  box: BoxInfo
): { start: number; end: number } {
  return { start: box.payloadOffset, end: box.payloadOffset + box.payloadSize };
}

export function readString4(buf: Buffer, off: number): string {
  return buf.toString("ascii", off, off + 4);
}

export function assertBounds(
  buf: Buffer,
  off: number,
  len: number,
  ctx: string
): void {
  if (off < 0 || len < 0 || off + len > buf.length) {
    throw new Error(`out of bounds ${ctx} at ${off}+${len}`);
  }
}
