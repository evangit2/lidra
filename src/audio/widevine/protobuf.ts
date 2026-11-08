/**
 * Minimal protobuf wire codec.
 *
 * The Widevine licence exchange is protobuf over HTTP. Pulling a full protobuf
 * runtime in for five messages would be heavier than the messages themselves, so
 * this module implements only the wire types those messages use: varint,
 * length-delimited and fixed32.
 */

export type ProtoValue =
  | { kind: "varint"; value: bigint }
  | { kind: "bytes"; value: Buffer }
  | { kind: "fixed32"; value: number };

export interface ProtoField {
  field: number;
  wire: number;
  value: ProtoValue;
}

export class ProtoWriter {
  private readonly chunks: Buffer[] = [];

  static varint(value: number | bigint): Buffer {
    let current = typeof value === "bigint" ? value : BigInt(value);
    if (current < 0n) throw new Error("varint must be non-negative");
    const bytes: number[] = [];
    do {
      let byte = Number(current & 0x7fn);
      current >>= 7n;
      if (current > 0n) byte |= 0x80;
      bytes.push(byte);
    } while (current > 0n);
    return Buffer.from(bytes);
  }

  private tag(field: number, wire: number): Buffer {
    return ProtoWriter.varint((field << 3) | wire);
  }

  varint(field: number, value: number | bigint): this {
    this.chunks.push(this.tag(field, 0), ProtoWriter.varint(value));
    return this;
  }

  bytes(field: number, value: Buffer): this {
    this.chunks.push(
      this.tag(field, 2),
      ProtoWriter.varint(value.length),
      value,
    );
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, Buffer.from(value, "utf8"));
  }

  message(field: number, value: Buffer): this {
    return this.bytes(field, value);
  }

  fixed32(field: number, value: number): this {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value, 0);
    this.chunks.push(this.tag(field, 5), buffer);
    return this;
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Parse a protobuf message into its fields, preserving order. */
export function parseProto(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;

  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (offset >= buffer.length) throw new Error("protobuf: truncated varint");
      const byte = buffer[offset] as number;
      offset += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("protobuf: varint too long");
    }
  };

  while (offset < buffer.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 0x7n);
    if (field === 0) throw new Error("protobuf: field 0 is invalid");
    if (wire === 0) {
      fields.push({ field, wire, value: { kind: "varint", value: readVarint() } });
    } else if (wire === 2) {
      const length = Number(readVarint());
      if (offset + length > buffer.length) throw new Error("protobuf: truncated bytes");
      fields.push({
        field,
        wire,
        value: { kind: "bytes", value: buffer.subarray(offset, offset + length) },
      });
      offset += length;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw new Error("protobuf: truncated fixed32");
      fields.push({
        field,
        wire,
        value: { kind: "fixed32", value: buffer.readUInt32LE(offset) },
      });
      offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw new Error("protobuf: truncated fixed64");
      offset += 8;
    } else {
      throw new Error(`protobuf: unsupported wire type ${wire}`);
    }
  }
  return fields;
}

export function firstBytes(fields: ProtoField[], field: number): Buffer | null {
  const found = fields.find((entry) => entry.field === field && entry.value.kind === "bytes");
  if (!found || found.value.kind !== "bytes") return null;
  return found.value.value;
}

export function allBytes(fields: ProtoField[], field: number): Buffer[] {
  return fields
    .filter((entry) => entry.field === field && entry.value.kind === "bytes")
    .map((entry) => (entry.value.kind === "bytes" ? entry.value.value : Buffer.alloc(0)));
}

export function firstVarint(fields: ProtoField[], field: number): number | null {
  const found = fields.find((entry) => entry.field === field && entry.value.kind === "varint");
  return found && found.value.kind === "varint" ? Number(found.value.value) : null;
}
