/**
 * CDM device blob handling.
 *
 * A Widevine device is a client-identification protobuf plus an RSA private key.
 * Lidra ships none: the user supplies their own dump in the format the
 * widevine tooling already uses (`.wvd`, or the two files separately).
 *
 * `.wvd` layout: u32be len + client_id + u32be len + private key (PEM or DER).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import log from "electron-log/main";

const deviceLog = log.scope("audio.widevine");

export interface WidevineDevice {
  /** Serialised ClientIdentification protobuf, sent as-is in licence requests. */
  clientId: Buffer;
  privateKey: crypto.KeyObject;
  /** Derived for diagnostics only; never logged in full. */
  keyBits: number;
}

export class DeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceError";
  }
}

function parsePrivateKey(raw: Buffer): crypto.KeyObject {
  const text = raw.toString("utf8");
  const looksPem = text.includes("-----BEGIN");
  try {
    return looksPem
      ? crypto.createPrivateKey({ key: text, format: "pem" })
      : crypto.createPrivateKey({ key: raw, format: "der", type: "pkcs1" });
  } catch (pemError) {
    try {
      return crypto.createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
    } catch {
      throw new DeviceError(
        `cannot parse the device private key: ${pemError instanceof Error ? pemError.message : String(pemError)}`,
      );
    }
  }
}

function finish(clientId: Buffer, privateKeyRaw: Buffer): WidevineDevice {
  if (clientId.length < 2) throw new DeviceError("client id blob is empty");
  const privateKey = parsePrivateKey(privateKeyRaw);
  const details = privateKey.asymmetricKeyDetails;
  const keyBits = details?.modulusLength ?? 2048;
  if (keyBits < 2048) {
    throw new DeviceError(`device key is ${keyBits} bits; Widevine needs at least 2048`);
  }
  deviceLog.info(`device loaded (${keyBits}-bit key, ${clientId.length}-byte client id)`);
  return { clientId, privateKey, keyBits };
}

/** Parse a pywidevine-style `.wvd` buffer. */
export function parseWvd(buffer: Buffer): WidevineDevice {
  if (buffer.length < 8) throw new DeviceError("device blob is truncated");
  const clientIdLength = buffer.readUInt32BE(0);
  if (clientIdLength === 0 || 4 + clientIdLength + 4 > buffer.length) {
    throw new DeviceError("device blob has an invalid client id length");
  }
  const clientId = buffer.subarray(4, 4 + clientIdLength);
  const keyLength = buffer.readUInt32BE(4 + clientIdLength);
  const keyStart = 8 + clientIdLength;
  if (keyLength === 0 || keyStart + keyLength > buffer.length) {
    throw new DeviceError("device blob has an invalid private key length");
  }
  return finish(Buffer.from(clientId), buffer.subarray(keyStart, keyStart + keyLength));
}

/** Parse `client_id.bin` plus `private_key.pem` supplied as separate files. */
export function parseClientAndKey(clientId: Buffer, key: Buffer): WidevineDevice {
  return finish(Buffer.from(clientId), key);
}

export interface DevicePaths {
  /** `.wvd` file, or a `client_id.bin` file when `privateKey` is set. */
  blob: string;
  privateKey?: string;
}

/** Load a device from disk, accepting both layouts. */
export function loadDevice(paths: DevicePaths): WidevineDevice {
  if (!fs.existsSync(paths.blob)) {
    throw new DeviceError(`device blob not found: ${paths.blob}`);
  }
  const blob = fs.readFileSync(paths.blob);
  if (paths.privateKey) {
    if (!fs.existsSync(paths.privateKey)) {
      throw new DeviceError(`device private key not found: ${paths.privateKey}`);
    }
    return parseClientAndKey(blob, fs.readFileSync(paths.privateKey));
  }
  return parseWvd(blob);
}

/** Parse a device path spec: `file.wvd` or `dir` containing the two files. */
export function loadDeviceSpec(spec: string): WidevineDevice {
  const trimmed = spec.trim();
  if (!trimmed) throw new DeviceError("no device configured");
  if (fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory()) {
    return loadDevice({
      blob: `${trimmed}/client_id.bin`,
      privateKey: `${trimmed}/private_key.pem`,
    });
  }
  return loadDevice({ blob: trimmed });
}
