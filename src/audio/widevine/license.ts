/**
 * Widevine licence acquisition against Apple Music.
 *
 * This is the same exchange Apple's own Widevine clients perform, driven by the
 * user's signed-in session and the user's own CDM device blob:
 *
 *   licence request  = SignedMessage(LicenseRequest) signed with the device key
 *   response         = SignedMessage(License) carrying an RSA-wrapped session key
 *   content key      = AES-CBC decrypt under CMAC(session key, request)
 *
 * The request goes to the endpoint Apple publishes for web playback, with the
 * developer token and media user token the page already uses, so entitlement is
 * the subscriber's own.
 */
import crypto from "node:crypto";
import log from "electron-log/main";
import { aesCmac } from "./cmac";
import { ProtoWriter, parseProto, firstBytes, firstVarint, allBytes } from "./protobuf";
import { parseWidevinePssh, buildLicenseKeyUri, psshKeyId, PsshError } from "./pssh";
import type { WidevineDevice } from "./device";

const licenseLog = log.scope("audio.widevine");

export const LICENSE_ENDPOINT =
  "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense";

const PROTOCOL_VERSION = 21;
const SIGNED_MESSAGE_LICENSE_REQUEST = 1;
const LICENSE_REQUEST_TYPE_NEW = 1;
const LICENSE_TYPE_DEFAULT = 0;
const KEY_TYPE_CONTENT = 2;
const REQUEST_TIMEOUT_MS = 20_000;

export interface LicenseCredentials {
  developerToken: string;
  mediaUserToken: string;
}

export interface LicenseRequestOptions {
  device: WidevineDevice;
  credentials: LicenseCredentials;
  adamId: string;
  /** The playlist's key URI: a `data:` URI carrying a Widevine pssh box. */
  keyUri: string;
  storefront?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export class LicenseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LicenseError";
  }
}

/** Build a signed licence request; exported for tests. */
export function buildLicenseRequest(
  device: WidevineDevice,
  psshData: Buffer,
  now: number = Math.floor(Date.now() / 1000),
): { signed: Buffer; message: Buffer; requestId: Buffer } {
  const requestId = crypto.randomBytes(16);

  const cenc = new ProtoWriter()
    .message(1, psshData)
    .varint(2, LICENSE_TYPE_DEFAULT)
    .bytes(3, requestId)
    .finish();

  const contentId = new ProtoWriter().message(1, cenc).finish();

  const message = new ProtoWriter()
    .message(1, device.clientId)
    .message(2, contentId)
    .varint(3, LICENSE_REQUEST_TYPE_NEW)
    .varint(4, now)
    .varint(7, crypto.randomBytes(4).readUInt32BE(0))
    .varint(6, PROTOCOL_VERSION)
    .finish();

  const signature = crypto.sign("sha1", message, {
    key: device.privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  const signed = new ProtoWriter()
    .varint(1, SIGNED_MESSAGE_LICENSE_REQUEST)
    .bytes(2, message)
    .bytes(3, signature)
    .finish();

  return { signed, message, requestId };
}

function pkcs7Unpad(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  const pad = buffer[buffer.length - 1] as number;
  if (pad === 0 || pad > 16 || pad > buffer.length) return buffer;
  for (let index = buffer.length - pad; index < buffer.length; index += 1) {
    if (buffer[index] !== pad) return buffer;
  }
  return buffer.subarray(0, buffer.length - pad);
}

/**
 * Derive the content-key encryption key.
 *
 * Widevine uses AES-CMAC over a domain-separated string built from the exact
 * serialised licence request, keyed by the session key the licence returned.
 */
export function deriveEncryptionKey(sessionKey: Buffer, licenseRequestMessage: Buffer): Buffer {
  const prefix = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from("ENCRYPTION", "ascii"),
    Buffer.from([0x00]),
  ]);
  const suffix = Buffer.from([0x00, 0x00, 0x00, 0x80]);
  return aesCmac(sessionKey, Buffer.concat([prefix, licenseRequestMessage, suffix]));
}

/** Parse a SignedMessage into its fields. */
export function parseSignedMessage(buffer: Buffer): {
  type: number | null;
  msg: Buffer;
  sessionKey: Buffer | null;
} {
  const fields = parseProto(buffer);
  const type = firstVarint(fields, 1);
  const msg = firstBytes(fields, 2);
  const sessionKey = firstBytes(fields, 4);
  if (!msg) throw new LicenseError("licence response carries no message");
  return { type, msg, sessionKey };
}

/**
 * Decrypt the content key from a licence response.
 * Exported so tests can drive it with a synthetic licence.
 */
export function extractContentKey(
  licenseResponse: Buffer,
  device: WidevineDevice,
  licenseRequestMessage: Buffer,
): Buffer {
  const signed = parseSignedMessage(licenseResponse);
  if (!signed.sessionKey) throw new LicenseError("licence response carries no session key");

  let sessionKey: Buffer;
  try {
    sessionKey = crypto.privateDecrypt(
      {
        key: device.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha1",
      },
      signed.sessionKey,
    );
  } catch (error) {
    throw new LicenseError(
      `cannot unwrap the session key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const encryptionKey = deriveEncryptionKey(sessionKey, licenseRequestMessage);
  const licenseFields = parseProto(signed.msg);

  for (const container of allBytes(licenseFields, 3)) {
    const keyFields = parseProto(container);
    const type = firstVarint(keyFields, 4);
    const encrypted = firstBytes(keyFields, 3);
    const iv = firstBytes(keyFields, 2);
    if (!encrypted || !iv) continue;
    if (type !== KEY_TYPE_CONTENT) continue;
    if (iv.length !== 16) throw new LicenseError("licence key IV is not 16 bytes");
    try {
      const decipher = crypto.createDecipheriv("aes-128-cbc", encryptionKey, iv);
      decipher.setAutoPadding(false);
      const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      const key = pkcs7Unpad(plain);
      if (key.length === 16) return Buffer.from(key);
    } catch (error) {
      throw new LicenseError(
        `cannot decrypt the content key: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new LicenseError(
    "licence response contained no usable content key (Apple may require privacy mode with a service certificate)",
  );
}

/** Full flow: pssh -> signed request -> Apple -> 16-byte content key. */
export async function acquireContentKey(options: LicenseRequestOptions): Promise<Buffer> {
  const { device, credentials, adamId, keyUri } = options;
  if (!credentials.developerToken || !credentials.mediaUserToken) {
    throw new LicenseError("sign in to Apple Music before requesting a licence");
  }

  let pssh;
  try {
    pssh = parseWidevinePssh(keyUri);
  } catch (error) {
    if (error instanceof PsshError) throw new LicenseError(error.message);
    throw error;
  }

  const { signed, message } = buildLicenseRequest(device, pssh.data);
  const kid = psshKeyId(pssh);

  const body = {
    challenge: signed.toString("base64"),
    "key-system": "com.widevine.alpha",
    // Apple is sent the CENC header in the same shape its own clients use, with
    // the KID the playlist declared.
    uri: buildLicenseKeyUri(pssh.data),
    adamId,
    isLibrary: false,
    "user-initiated": true,
  };

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(options.endpoint ?? LICENSE_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.developerToken}`,
        "x-apple-music-user-token": credentials.mediaUserToken,
        "content-type": "application/json",
        origin: "https://music.apple.com",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new LicenseError(
      `licence request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new LicenseError(`licence endpoint returned ${response.status}: ${text.slice(0, 300)}`, response.status);
  }

  let payload: { license?: string; errorCode?: number; status?: number };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new LicenseError(`licence endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (payload.errorCode || payload.status) {
    throw new LicenseError(
      `licence refused (errorCode ${payload.errorCode ?? 0}, status ${payload.status ?? 0})`,
    );
  }
  if (!payload.license) throw new LicenseError("licence response carried no licence");

  const key = extractContentKey(Buffer.from(payload.license, "base64"), device, message);
  licenseLog.info(
    `licence granted for ${adamId} (kid ${kid ? kid.toString("hex") : "unknown"})`,
  );
  return key;
}
