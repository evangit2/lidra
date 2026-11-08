/**
 * Content key acquisition.
 *
 * Lidra does not bundle a DRM component. Keys for the renditions it plays come
 * from a key service the user runs and is entitled to use — typically the same
 * authenticated FairPlay session that a licensed client establishes. The
 * service is a black box here: it is asked for the key belonging to one
 * (song, key URI) pair and it answers with 16 raw bytes.
 *
 * Two transports are supported, both deliberately small:
 *   - `socket`: newline-delimited JSON over TCP or a Unix socket.
 *   - `http`:   POST JSON, bearer token optional.
 *
 * Request:  {"adamId":"123","keyUri":"skd://itunes.apple.com/…","kid":"<hex>"}
 * Response: {"key":"<base64 of 16 bytes>"}  or  {"error":"reason"}
 */
import net from "node:net";
import crypto from "node:crypto";
import log from "electron-log/main";

const keyLog = log.scope("audio.keys");

export interface KeyRequest {
  adamId: string;
  keyUri: string;
  kid?: string;
  storefront?: string;
}

export interface KeyProvider {
  readonly name: string;
  getKey(request: KeyRequest): Promise<Buffer>;
}

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

function decodeKey(payload: unknown): Buffer {
  if (typeof payload !== "object" || payload === null) {
    throw new KeyError("key service returned a non-object response");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") {
    throw new KeyError(`key service error: ${record.error}`);
  }
  // Accept base64 by default, plus hex for services that report keys that way.
  if (typeof record.key === "string") {
    const fromBase64 = Buffer.from(record.key, "base64");
    if (fromBase64.length === 16) return fromBase64;
    const fromHex = Buffer.from(record.key, "hex");
    if (fromHex.length === 16) return fromHex;
    throw new KeyError(`key service returned ${fromBase64.length} bytes, expected 16`);
  }
  if (Array.isArray(record.key) && record.key.length === 16) {
    const bytes = record.key;
    if (bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
      return Buffer.from(bytes as number[]);
    }
  }
  throw new KeyError("key service response carried no usable key");
}

/** Parse `host:port` or an absolute `unix:/path` address. */
export function parseSocketAddress(address: string): net.NetConnectOpts {
  if (address.startsWith("unix:")) {
    return { path: address.slice("unix:".length) };
  }
  const lastColon = address.lastIndexOf(":");
  if (lastColon === -1) return { path: address };
  const host = address.slice(0, lastColon) || "127.0.0.1";
  const port = Number.parseInt(address.slice(lastColon + 1), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new KeyError(`invalid key service address: ${address}`);
  }
  return { host, port };
}

/** Key service speaking newline-delimited JSON over TCP or a Unix socket. */
export class SocketKeyProvider implements KeyProvider {
  readonly name = "socket";

  constructor(
    private readonly address: string,
    private readonly timeoutMs = 10_000,
  ) {}

  getKey(request: KeyRequest): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const options = parseSocketAddress(this.address);
      const socket = net.createConnection(options);
      let buffer = "";
      let settled = false;
      const finish = (error: Error | null, key?: Buffer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else if (key) resolve(key);
      };
      const timer = setTimeout(
        () => finish(new KeyError("key service timed out")),
        this.timeoutMs,
      );
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline).trim();
        try {
          finish(null, decodeKey(JSON.parse(line)));
        } catch (error) {
          finish(error instanceof Error ? error : new KeyError(String(error)));
        }
      });
      socket.on("error", (error) => finish(new KeyError(error.message)));
      socket.on("close", () => {
        if (!settled) finish(new KeyError("key service closed the connection"));
      });
    });
  }
}

/** Key service speaking JSON over HTTP(S). */
export class HttpKeyProvider implements KeyProvider {
  readonly name = "http";

  constructor(
    private readonly endpoint: string,
    private readonly bearerToken?: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async getKey(request: KeyRequest): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new KeyError(`key service returned ${response.status}: ${text.slice(0, 200)}`);
      }
      return decodeKey(JSON.parse(text));
    } catch (error) {
      if (error instanceof KeyError) throw error;
      throw new KeyError(
        `key request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Reports the missing configuration instead of failing a play silently. */
export class UnconfiguredKeyProvider implements KeyProvider {
  readonly name = "unconfigured";

  async getKey(): Promise<Buffer> {
    throw new KeyError(
      "no key source configured: set LIDRA_WIDEVINE_DEVICE to a CDM device blob, or a key service via LIDRA_KEY_SERVICE",
    );
  }
}

/** Memoises keys for the process lifetime; keys do not rotate within a song. */
export class KeyCache {
  private readonly memory = new Map<string, Buffer>();

  constructor(private readonly provider: KeyProvider) {}

  get providerName(): string {
    return this.provider.name;
  }

  private static cacheKey(request: KeyRequest): string {
    return `${request.adamId}\u0000${request.keyUri}`;
  }

  async get(request: KeyRequest): Promise<Buffer> {
    const cacheKey = KeyCache.cacheKey(request);
    const cached = this.memory.get(cacheKey);
    if (cached) return cached;
    const key = await this.provider.getKey(request);
    if (key.length !== 16) throw new KeyError(`key has ${key.length} bytes, expected 16`);
    this.memory.set(cacheKey, key);
    // Never log key material; log only that a key was resolved.
    keyLog.info(
      `resolved key for ${request.adamId} (${crypto.createHash("sha256").update(key).digest("hex").slice(0, 8)}…)`,
    );
    return key;
  }

  clear(): void {
    this.memory.clear();
  }
}

/** Build the configured provider from Lidra's audio settings. */
export function createKeyProvider(config: {
  transport: "socket" | "http";
  address: string;
  token?: string;
}): KeyProvider {
  if (!config.address.trim()) return new UnconfiguredKeyProvider();
  if (config.transport === "http") {
    return new HttpKeyProvider(config.address.trim(), config.token);
  }
  return new SocketKeyProvider(config.address.trim());
}
