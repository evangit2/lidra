import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { aesCmac } from "../src/audio/widevine/cmac";
import { parseWvd, parseClientAndKey, DeviceError } from "../src/audio/widevine/device";
import {
  parsePssh,
  parseWidevinePssh,
  decodeKeyUri,
  psshKeyId,
  buildLicenseKeyUri,
  PsshError,
} from "../src/audio/widevine/pssh";
import {
  buildLicenseRequest,
  deriveEncryptionKey,
  extractContentKey,
  acquireContentKey,
} from "../src/audio/widevine/license";
import { ProtoWriter, parseProto, firstBytes, firstVarint, allBytes } from "../src/audio/widevine/protobuf";
import type { WidevineDevice } from "../src/audio/widevine/device";

const WIDEVINE_SYSTEM_ID = Buffer.from("edef8ba979d64acea3c827dcd51d21ed", "hex");

/** Build a pssh box carrying a WidevineCencHeader, as Apple does. */
function buildPssh(keyId: Buffer, contentId: string, version = 0): Buffer {
  const cencHeader = new ProtoWriter()
    .varint(1, 1) // algorithm AESCTR
    .bytes(2, keyId)
    .bytes(4, Buffer.from(contentId, "ascii"))
    .finish();

  const kids = version === 1 ? Buffer.concat([u32(1), keyId]) : Buffer.alloc(0);
  const body = Buffer.concat([
    Buffer.from([version, 0, 0, 0]),
    WIDEVINE_SYSTEM_ID,
    kids,
    u32(cencHeader.length),
    cencHeader,
  ]);
  return Buffer.concat([u32(8 + body.length), Buffer.from("pssh", "latin1"), body]);
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function makeDevice(): { device: WidevineDevice; publicKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const clientId = new ProtoWriter()
    .varint(1, 1)
    .bytes(4, Buffer.from("lidra-test-device", "utf8"))
    .finish();
  return {
    device: { clientId, privateKey, keyBits: 2048 },
    publicKey,
  };
}

/** Wrap a 16-byte content key the way the licence server does. */
function buildLicenseResponse(
  publicKey: crypto.KeyObject,
  sessionKey: Buffer,
  requestMessage: Buffer,
  contentKey: Buffer,
  iv: Buffer,
): Buffer {
  const encryptionKey = deriveEncryptionKey(sessionKey, requestMessage);
  const cipher = crypto.createCipheriv("aes-128-cbc", encryptionKey, iv);
  cipher.setAutoPadding(false);
  const padding = Buffer.alloc(16, 16);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([contentKey, padding])), cipher.final()]);

  const container = new ProtoWriter()
    .bytes(1, crypto.createHash("sha256").update(contentKey).digest().subarray(0, 16))
    .bytes(2, iv)
    .bytes(3, encrypted)
    .varint(4, 2) // CONTENT
    .finish();

  const license = new ProtoWriter().message(3, container).finish();

  const wrappedSessionKey = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    sessionKey,
  );

  return new ProtoWriter()
    .varint(1, 2) // LICENSE
    .bytes(2, license)
    .bytes(4, wrappedSessionKey)
    .finish();
}

describe("AES-CMAC", () => {
  it("matches the RFC 4493 test vectors", () => {
    const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
    const message = Buffer.from(
      "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710",
      "hex",
    );
    // RFC 4493: CMAC of the first 16 bytes.
    expect(aesCmac(key, message.subarray(0, 16)).toString("hex")).toBe(
      "070a16b46b4d4144f79bdd9dd04a287c",
    );
    // RFC 4493: CMAC of 40 bytes.
    expect(aesCmac(key, message.subarray(0, 40)).toString("hex")).toBe(
      "dfa66747de9ae63030ca32611497c827",
    );
    // RFC 4493: CMAC of all 64 bytes.
    expect(aesCmac(key, message).toString("hex")).toBe(
      "51f0bebf7e3b9d92fc49741779363cfe",
    );
  });
});

describe("protobuf", () => {
  it("round-trips varints, bytes and nested messages", () => {
    const inner = new ProtoWriter().varint(1, 7).bytes(2, Buffer.from("inner")).finish();
    const encoded = new ProtoWriter()
      .varint(1, 1)
      .bytes(2, Buffer.from("outer"))
      .message(3, inner)
      .varint(4, 300)
      .finish();

    const fields = parseProto(encoded);
    expect(firstVarint(fields, 1)).toBe(1);
    expect(firstBytes(fields, 2)?.toString()).toBe("outer");
    expect(firstVarint(fields, 4)).toBe(300);
    const nested = parseProto(firstBytes(fields, 3) as Buffer);
    expect(firstVarint(nested, 1)).toBe(7);
    expect(firstBytes(nested, 2)?.toString()).toBe("inner");
  });

  it("rejects truncated input", () => {
    expect(() => parseProto(Buffer.from([0x0a, 0x05, 0x01]))).toThrow(/truncated/);
  });
});

describe("pssh parsing", () => {
  const keyId = crypto.randomBytes(16);

  it("parses a v0 box from a data URI", () => {
    const pssh = buildPssh(keyId, "s1/e1");
    const uri = `data:text/plain;base64,${pssh.toString("base64")}`;
    const parsed = parseWidevinePssh(uri);
    expect(parsed.systemId).toBe(WIDEVINE_SYSTEM_ID.toString("hex"));
    expect(parsed.data.length).toBeGreaterThan(0);
    const header = parseProto(parsed.data);
    expect(firstBytes(header, 2)?.equals(keyId)).toBe(true);
  });

  it("parses v1 key ids", () => {
    const parsed = parsePssh(buildPssh(keyId, "s1/e1", 1));
    expect(parsed.keyIds).toHaveLength(1);
    expect(parsed.keyIds[0].equals(keyId)).toBe(true);
  });

  it("exposes the KID the playlist declared", () => {
    const parsed = parseWidevinePssh(`data:;base64,${buildPssh(keyId, "s1/e1").toString("base64")}`);
    expect(psshKeyId(parsed)?.equals(keyId)).toBe(true);
  });

  it("shapes the licence uri like Apple's own clients", () => {
    const cencHeader = new ProtoWriter().varint(1, 1).bytes(2, keyId).finish();
    const uri = buildLicenseKeyUri(cencHeader);
    expect(uri.startsWith("data:;base64,")).toBe(true);
    const decoded = decodeKeyUri(uri);
    expect(decoded.subarray(0, 32).toString("ascii")).toBe("0123456789abcdef0123456789abcdef");
    expect(decoded.subarray(32).equals(cencHeader)).toBe(true);
  });

  it("rejects a FairPlay-style key URI", () => {
    expect(() => decodeKeyUri("skd://itunes.apple.com/P000000000/s1/e1")).toThrow(PsshError);
    expect(() => parseWidevinePssh("skd://itunes.apple.com/x")).toThrow(/unsupported key URI/);
  });

  it("rejects a non-Widevine system id", () => {
    const pssh = buildPssh(keyId, "s1/e1");
    pssh.write("0000000000000000000000000000000f", 12, "hex");
    expect(() => parseWidevinePssh(`data:;base64,${pssh.toString("base64")}`)).toThrow(
      /not Widevine/,
    );
  });
});

describe("device blobs", () => {
  it("parses a wvd blob", () => {
    const { device } = makeDevice();
    const key = crypto.createPrivateKey(device.privateKey.export({ format: "pem", type: "pkcs1" }) as string)
      .export({ format: "pem", type: "pkcs1" }) as string;
    const blob = Buffer.concat([
      u32(device.clientId.length),
      device.clientId,
      u32(Buffer.byteLength(key)),
      Buffer.from(key),
    ]);
    const parsed = parseWvd(blob);
    expect(parsed.clientId.equals(device.clientId)).toBe(true);
    expect(parsed.keyBits).toBe(2048);
  });

  it("rejects truncated blobs", () => {
    expect(() => parseWvd(Buffer.from([0, 0]))).toThrow(DeviceError);
    expect(() => parseWvd(Buffer.concat([u32(100), Buffer.from("short")]))).toThrow(/client id/);
  });

  it("rejects a garbage private key", () => {
    const blob = Buffer.concat([u32(4), Buffer.from("abcd"), u32(4), Buffer.from("nope")]);
    expect(() => parseWvd(blob)).toThrow(/cannot parse the device private key/);
  });

  it("accepts separate client id and key buffers", () => {
    const { device } = makeDevice();
    const pem = device.privateKey.export({ format: "pem", type: "pkcs1" }) as string;
    expect(parseClientAndKey(device.clientId, Buffer.from(pem)).keyBits).toBe(2048);
  });
});

describe("licence exchange", () => {
  const keyId = crypto.randomBytes(16);
  const pssh = buildPssh(keyId, "s1/e1");

  it("signs the licence request with the device key", () => {
    const { device, publicKey } = makeDevice();
    const { signed, message } = buildLicenseRequest(device, parsePssh(pssh).data);
    const fields = parseProto(signed);
    expect(firstVarint(fields, 1)).toBe(1);
    expect(firstBytes(fields, 2)?.equals(message)).toBe(true);
    const signature = firstBytes(fields, 3) as Buffer;
    expect(
      crypto.verify(
        "sha1",
        message,
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 },
        signature,
      ),
    ).toBe(true);
  });

  it("recovers the content key from a licence response", () => {
    const { device, publicKey } = makeDevice();
    const parsedPssh = parsePssh(pssh);
    const { message } = buildLicenseRequest(device, parsedPssh.data);
    const sessionKey = crypto.randomBytes(16);
    const contentKey = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const response = buildLicenseResponse(publicKey, sessionKey, message, contentKey, iv);
    expect(extractContentKey(response, device, message).equals(contentKey)).toBe(true);
  });

  it("rejects a licence that carries no content key", () => {
    const { device, publicKey } = makeDevice();
    const { message } = buildLicenseRequest(device, parsePssh(pssh).data);
    const wrapped = crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
      crypto.randomBytes(16),
    );
    const emptyLicense = new ProtoWriter().message(3, new ProtoWriter().bytes(1, keyId).finish()).finish();
    const response = new ProtoWriter().varint(1, 2).bytes(2, emptyLicense).bytes(4, wrapped).finish();
    expect(() => extractContentKey(response, device, message)).toThrow(/no usable content key/);
  });

  it("posts the challenge Apple expects and returns the key", async () => {
    const { device, publicKey } = makeDevice();
    let seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
    const contentKey = crypto.randomBytes(16);

    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const headers = init.headers as Record<string, string>;
      seen = { url, body, headers };
      const challenge = Buffer.from(String(body.challenge), "base64");
      const requestMessage = firstBytes(parseProto(challenge), 2) as Buffer;
      const sessionKey = crypto.randomBytes(16);
      const response = buildLicenseResponse(
        publicKey,
        sessionKey,
        requestMessage,
        contentKey,
        crypto.randomBytes(16),
      );
      return new Response(JSON.stringify({ license: response.toString("base64"), status: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const key = await acquireContentKey({
      device,
      credentials: { developerToken: "dev-token", mediaUserToken: "media-token" },
      adamId: "617154366",
      keyUri: `data:text/plain;base64,${pssh.toString("base64")}`,
      fetchImpl,
    });

    expect(key.equals(contentKey)).toBe(true);
    expect(seen).not.toBeNull();
    const request = seen as unknown as { url: string; body: Record<string, unknown>; headers: Record<string, string> };
    expect(request.url).toContain("acquireWebPlaybackLicense");
    expect(request.body["key-system"]).toBe("com.widevine.alpha");
    expect(request.body.adamId).toBe("617154366");
    expect(request.body["user-initiated"]).toBe(true);
    expect(request.headers.authorization).toBe("Bearer dev-token");
    expect(request.headers["x-apple-music-user-token"]).toBe("media-token");
  });

  it("surfaces licence refusals", async () => {
    const { device } = makeDevice();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errorCode: 4010, status: 0 }), { status: 200 })) as unknown as typeof fetch;
    await expect(
      acquireContentKey({
        device,
        credentials: { developerToken: "a", mediaUserToken: "b" },
        adamId: "1",
        keyUri: `data:;base64,${pssh.toString("base64")}`,
        fetchImpl,
      }),
    ).rejects.toThrow(/licence refused/);
  });

  it("refuses to request a licence without a session", async () => {
    const { device } = makeDevice();
    await expect(
      acquireContentKey({
        device,
        credentials: { developerToken: "", mediaUserToken: "" },
        adamId: "1",
        keyUri: `data:;base64,${pssh.toString("base64")}`,
      }),
    ).rejects.toThrow(/sign in/);
  });
});
