import crypto from "node:crypto";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  LegacyDecryptor,
  LegacyDecryptorError,
  armIdOf,
  fetchDeviceManifest,
  isPrefetchKey,
} from "../src/audio/legacy/decryptor";
import {
  DecryptMismatchError,
  decryptSegmentLegacy,
  sampleLayout,
  verifyFragmentPlaintext,
} from "../src/audio/legacy/segment";

const KEY = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const IV = Buffer.alloc(16, 0);

const box = (type: string, ...payload: Buffer[]): Buffer => {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
};

const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
};

/**
 * Build one fMP4 fragment shaped like Apple Music audio: `default-base-is-moof`,
 * a `trun` with an explicit data offset and per-sample sizes, and no `senc`
 * because SAMPLE-AES audio uses the constant IV from `tenc`.
 */
const buildFragment = (samples: Buffer[]): Buffer => {
  const mdat = box("mdat", ...samples);
  const tfhd = box(
    "tfhd",
    Buffer.from([0x02, 0, 0x00, 0x00]), // default-base-is-moof
    u32(1),
  );
  const makeTrun = (dataOffset: number): Buffer =>
    box(
      "trun",
      Buffer.from([0x00, 0x00, 0x02, 0x01]), // data offset + per-sample size
      u32(samples.length),
      (() => {
        const offset = Buffer.alloc(4);
        offset.writeInt32BE(dataOffset, 0);
        return offset;
      })(),
      ...samples.map((sample) => u32(sample.length)),
    );

  // The moof size does not depend on the data offset value, so the offset can
  // be computed in two passes.
  const provisionalMoof = box("moof", box("traf", tfhd, makeTrun(0)));
  const dataOffset = provisionalMoof.length + 8;
  const moof = box("moof", box("traf", tfhd, makeTrun(dataOffset)));
  return Buffer.concat([moof, mdat]);
};

/** Encrypt the way SAMPLE-AES does: whole sample, CBC, constant IV. */
const encrypt = (plain: Buffer): Buffer => {
  const cipher = crypto.createCipheriv("aes-128-cbc", KEY, IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
};

const decrypt = (ciphertext: Buffer): Buffer => {
  const decipher = crypto.createDecipheriv("aes-128-cbc", KEY, IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

/** Minimal wrapper-style decrypt service that speaks the documented protocol. */
const openDecryptService = async (): Promise<{
  address: string;
  events: string[];
  close: () => Promise<void>;
}> => {
  const events: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let armed = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!armed) {
          // The first arm is two length-prefixed strings; a re-arm arrives behind a
          // four-byte key-switch marker.
          const marker = buffer.length >= 4 && buffer.readUInt32LE(0) === 0;
          const offset = marker ? 4 : 0;
          if (buffer.length < offset + 1) return;
          const idLength = buffer[offset];
          if (buffer.length < offset + 2 + idLength) return;
          const adamId = buffer.subarray(offset + 1, offset + 1 + idLength).toString();
          const uriLength = buffer[offset + 1 + idLength];
          if (buffer.length < offset + 2 + idLength + uriLength) return;
          const uri = buffer.subarray(offset + 2 + idLength, offset + 2 + idLength + uriLength).toString();
          events.push(`${marker ? "switch:" : ""}arm:${adamId}:${uri}`);
          buffer = buffer.subarray(offset + 2 + idLength + uriLength);
          armed = true;
          continue;
        }
        if (buffer.length < 4) return;
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        events.push(`decrypt:${length}`);
        socket.write(decrypt(payload));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return {
    address: `127.0.0.1:${address.port}`,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};

describe("wrapper decryptor transport", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("walks trun sample offsets", () => {
    const samples = [Buffer.alloc(32, 0xaa), Buffer.alloc(48, 0xbb)];
    const fragment = buildFragment(samples);
    const layout = sampleLayout(fragment);
    expect(layout.fragments).toBe(1);
    expect(layout.trackId).toBe(1);
    expect(layout.samples.map((sample) => sample.size)).toEqual([32, 48]);
    expect(
      fragment.subarray(layout.samples[0].offset, layout.samples[0].offset + 32).equals(samples[0]),
    ).toBe(true);
    expect(
      fragment.subarray(layout.samples[1].offset, layout.samples[1].offset + 48).equals(samples[1]),
    ).toBe(true);
  });

  it("arms the session once and decrypts every sample", async () => {
    const service = await openDecryptService();
    closers.push(service.close);
    // Real ALAC frames repeat their header bits, which is what the fragment
    // verification keys on.
    const plainFrame = (size: number): Buffer => {
      const frame = Buffer.concat([Buffer.from([0x20, 0x00, 0x04]), crypto.randomBytes(size - 3)]);
      return frame;
    };
    const plain = [plainFrame(32), plainFrame(64)];
    const fragment = buildFragment(plain.map(encrypt));
    const decryptor = new LegacyDecryptor(service.address);

    const output = await decryptSegmentLegacy(fragment, decryptor, {
      adamId: "1440833098",
      // Apple's playlists open on a placeholder key, which the reference client
      // addresses with the literal id 0.
      keyUri: "skd://itunes.apple.com/P000000000/s1/e1",
    });
    const layout = sampleLayout(output);
    expect(
      output.subarray(layout.samples[0].offset, layout.samples[0].offset + 32).equals(plain[0]),
    ).toBe(true);
    expect(
      output.subarray(layout.samples[1].offset, layout.samples[1].offset + 64).equals(plain[1]),
    ).toBe(true);
    expect(service.events.filter((event) => event.startsWith("arm:"))).toEqual([
      "arm:0:skd://itunes.apple.com/P000000000/s1/e1",
    ]);
    decryptor.close();
  });


  it("addresses the placeholder key with the prefetch id", () => {
    expect(isPrefetchKey("skd://itunes.apple.com/P000000000/s1/e1")).toBe(true);
    expect(isPrefetchKey("skd://itunes.apple.com/p1305215351/c6")).toBe(false);
    expect(
      armIdOf({ adamId: "268443097", keyUri: "skd://itunes.apple.com/P000000000/s1/e1" }),
    ).toBe("0");
    expect(armIdOf({ adamId: "268443097", keyUri: "skd://itunes.apple.com/p1305215351/c6" })).toBe(
      "268443097",
    );
  });

  it("sends a whole fragment as one pipelined batch", async () => {
    const service = await openDecryptService();
    closers.push(service.close);
    const plain = Array.from({ length: 8 }, () =>
      Buffer.concat([Buffer.from([0x20, 0x00, 0x04]), crypto.randomBytes(45)]),
    );
    const fragment = buildFragment(plain.map(encrypt));
    const decryptor = new LegacyDecryptor(service.address);
    const output = await decryptSegmentLegacy(fragment, decryptor, {
      adamId: "268443097",
      keyUri: "skd://itunes.apple.com/p1305215351/c6",
    });
    const layout = sampleLayout(output);
    for (const [index, expected] of plain.entries()) {
      const sample = layout.samples[index];
      expect(output.subarray(sample.offset, sample.offset + sample.size).equals(expected)).toBe(true);
    }
    decryptor.close();
  });

  it("rejects plaintext that is not audio", () => {
    const plain = [crypto.randomBytes(48), crypto.randomBytes(48)];
    const fragment = buildFragment(plain.map(encrypt));
    const layout = sampleLayout(fragment);
    const noise = Buffer.from(fragment);
    crypto.randomFillSync(noise, layout.samples[0].offset, 96);
    const check = verifyFragmentPlaintext(noise, layout);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/ALAC header/);
  });

  it("leaves a trailing partial block in the clear", async () => {
    const service = await openDecryptService();
    closers.push(service.close);
    const aligned = crypto.randomBytes(32);
    const tail = Buffer.from([1, 2, 3, 4, 5]);
    const sample = Buffer.concat([aligned, tail]);
    const fragment = buildFragment([Buffer.concat([encrypt(aligned), tail])]);
    const decryptor = new LegacyDecryptor(service.address);
    const output = await decryptSegmentLegacy(fragment, decryptor, {
      adamId: "1",
      keyUri: "skd://a",
    });
    const layout = sampleLayout(output);
    const decrypted = output.subarray(layout.samples[0].offset, layout.samples[0].offset + 37);
    expect(decrypted.subarray(0, 32).equals(aligned)).toBe(true);
    expect(decrypted.subarray(32).equals(tail)).toBe(true);
    decryptor.close();
  });

  it("reports a missing service instead of hanging", async () => {
    const decryptor = new LegacyDecryptor("127.0.0.1:1", 500);
    await expect(
      decryptor.decrypt(Buffer.alloc(32), { adamId: "1", keyUri: "skd://a" }),
    ).rejects.toThrow(LegacyDecryptorError);
  });
});

describe("wrapper manifest transport", () => {
  it("requests a manifest by song id", async () => {
    let received = "";
    const server = net.createServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        received = chunk.subarray(1).toString();
        socket.write("https://aod.example.test/song/master.m3u8\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    try {
      const url = await fetchDeviceManifest("1440833098", `127.0.0.1:${address.port}`);
      expect(received).toBe("1440833098");
      expect(url).toBe("https://aod.example.test/song/master.m3u8");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a non-URL response", async () => {
    const server = net.createServer((socket) => {
      socket.on("data", () => socket.write("none\n"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("no address");
    try {
      await expect(
        fetchDeviceManifest("1", `127.0.0.1:${address.port}`),
      ).rejects.toThrow(/manifest service returned/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
