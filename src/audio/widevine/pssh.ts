/**
 * PSSH handling.
 *
 * The Widevine key URI Apple puts in an `enhancedHls` media playlist is a `data:`
 * URI carrying a full `pssh` box. The box's data region is a
 * WidevineCencHeader protobuf, which the licence request must carry verbatim.
 */

const WIDEVINE_SYSTEM_ID = "edef8ba979d64acea3c827dcd51d21ed";

export interface PsshData {
  systemId: string;
  keyIds: Buffer[];
  /** WidevineCencHeader protobuf, passed straight through to the licence request. */
  data: Buffer;
}

export class PsshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsshError";
  }
}

/** Decode a `data:` URI or bare base64 string into bytes. */
export function decodeKeyUri(keyUri: string): Buffer {
  const trimmed = keyUri.trim();
  if (trimmed.startsWith("data:")) {
    const comma = trimmed.indexOf(",");
    if (comma === -1) throw new PsshError("malformed data URI");
    const header = trimmed.slice(5, comma);
    const payload = trimmed.slice(comma + 1);
    return header.includes(";base64")
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
  }
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length % 4 === 0) {
    return Buffer.from(trimmed, "base64");
  }
  throw new PsshError(`unsupported key URI: ${trimmed.slice(0, 40)}`);
}

/** Parse a pssh box (ISO/IEC 23001-7) into its system id, KIDs and data. */
export function parsePssh(box: Buffer): PsshData {
  if (box.length < 32) throw new PsshError("pssh box is truncated");
  const size = box.readUInt32BE(0);
  if (size !== box.length) {
    // Tolerate a leading size field that disagrees with the buffer by using the
    // declared size when it fits, otherwise trust the buffer.
    if (size > box.length) throw new PsshError("pssh box is truncated");
  }
  const type = box.toString("latin1", 4, 8);
  if (type !== "pssh") throw new PsshError(`expected a pssh box, got ${type}`);
  const version = box[8] as number;
  const systemId = box.toString("hex", 12, 28);
  let offset = 28;
  const keyIds: Buffer[] = [];
  if (version === 1) {
    if (offset + 4 > size) throw new PsshError("pssh v1 is truncated");
    const count = box.readUInt32BE(offset);
    offset += 4;
    for (let index = 0; index < count; index += 1) {
      if (offset + 16 > size) throw new PsshError("pssh v1 key id is truncated");
      keyIds.push(Buffer.from(box.subarray(offset, offset + 16)));
      offset += 16;
    }
  }
  if (offset + 4 > size) throw new PsshError("pssh is missing its data size");
  const dataSize = box.readUInt32BE(offset);
  offset += 4;
  if (offset + dataSize > size) throw new PsshError("pssh data is truncated");
  const data = Buffer.from(box.subarray(offset, offset + dataSize));
  return { systemId, keyIds, data };
}

/** Parse a key URI, insisting that it describes a Widevine-protected track. */
export function parseWidevinePssh(keyUri: string): PsshData {
  const parsed = parsePssh(decodeKeyUri(keyUri));
  if (parsed.systemId !== WIDEVINE_SYSTEM_ID) {
    throw new PsshError(
      `key URI belongs to system ${parsed.systemId}, not Widevine (FairPlay uses skd://)`,
    );
  }
  return parsed;
}
