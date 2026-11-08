/**
 * Compatibility with the wrapper-style decryptor service.
 *
 * The reference downloader in the wild pairs an authenticated Apple Music
 * wrapper with a local decrypt socket: the client sends the song id and the
 * `skd://` key URI, then hands over ciphertext in length-prefixed chunks and
 * gets plaintext back. The key never leaves that service, so this transport is
 * the lowest-trust option and is offered alongside the plain key-service mode.
 *
 * Wire format (little-endian, matching the wrapper family of services):
 *   select key : 00 00 00 00                      (switch/arm the session)
 *                [len][adamId]  [len][skd:// URI]
 *   decrypt    : [u32 length][ciphertext]         -> exactly `length` plaintext bytes
 *   close      : 00 00 00 00 00
 * where `len` is a single byte.
 */
import net from "node:net";
import log from "electron-log/main";

const legacyLog = log.scope("audio.legacy");

const MAX_CHUNK = 4 * 1024 * 1024;

export class LegacyDecryptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyDecryptorError";
  }
}

export interface LegacyRequest {
  adamId: string;
  keyUri: string;
}

/** Serialises requests onto one connection: the service is stateful. */
export class LegacyDecryptor {
  private socket: net.Socket | null = null;
  private queue: Promise<void> = Promise.resolve();
  private armed: string | null = null;

  constructor(
    private readonly address: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    const address = this.address;
    const options: net.NetConnectOpts = address.startsWith("unix:")
      ? { path: address.slice("unix:".length) }
      : (() => {
          const colon = address.lastIndexOf(":");
          if (colon === -1) throw new LegacyDecryptorError(`invalid decryptor address: ${address}`);
          return {
            host: address.slice(0, colon) || "127.0.0.1",
            port: Number.parseInt(address.slice(colon + 1), 10),
          };
        })();
    const socket = net.createConnection(options);
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new LegacyDecryptorError("decryptor connection timed out"));
      }, this.timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new LegacyDecryptorError(error.message));
      });
    });
    this.socket = socket;
    return socket;
  }

  private static sendString(socket: net.Socket, value: string): void {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > 255) throw new LegacyDecryptorError("string too long for the wire format");
    socket.write(Buffer.concat([Buffer.from([bytes.length]), bytes]));
  }

  /** Arm the service for one (song, key URI) pair. */
  private async arm(request: LegacyRequest): Promise<void> {
    const socket = await this.connect();
    socket.write(Buffer.from([0, 0, 0, 0]));
    LegacyDecryptor.sendString(socket, request.adamId);
    LegacyDecryptor.sendString(socket, request.keyUri);
    await this.drain();
    this.armed = `${request.adamId}\u0000${request.keyUri}`;
    legacyLog.info(`armed decryptor for ${request.adamId}`);
  }

  /** Resolve once everything written so far has been flushed to the kernel. */
  private drain(): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => socket.write(Buffer.alloc(0), () => resolve()));
  }

  /**
   * Decrypt one encrypted run. Complete 16-byte blocks are sent; a trailing
   * partial block stays in the clear, which is how SAMPLE-AES audio behaves.
   */
  async decrypt(run: Buffer, request: LegacyRequest): Promise<Buffer> {
    if (run.length === 0) return run;
    const usable = run.length & ~0xf;
    if (usable === 0) return run;
    if (usable > MAX_CHUNK) throw new LegacyDecryptorError("chunk exceeds the service limit");

    const task = this.queue.then(async () => {
      if (this.armed !== `${request.adamId}\u0000${request.keyUri}`) {
        await this.arm(request);
      }
      const socket = await this.connect();
      const header = Buffer.alloc(4);
      header.writeUInt32LE(usable, 0);
      socket.write(header);
      socket.write(run.subarray(0, usable));
      const plain = await this.read(usable);
      if (plain.length !== usable) {
        throw new LegacyDecryptorError(
          `decryptor returned ${plain.length} bytes, expected ${usable}`,
        );
      }
      const output = Buffer.from(run);
      plain.copy(output, 0);
      return output;
    });
    // Keep the queue alive even when a call rejects.
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private read(length: number): Promise<Buffer> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new LegacyDecryptorError("decryptor is not connected"));
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      const timer = setTimeout(() => {
        cleanup();
        reject(new LegacyDecryptorError("decryptor response timed out"));
      }, this.timeoutMs);
      const onData = (chunk: Buffer): void => {
        chunks.push(chunk);
        received += chunk.length;
        if (received >= length) {
          cleanup();
          resolve(Buffer.concat(chunks).subarray(0, length));
        }
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new LegacyDecryptorError(error.message));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
      };
      socket.on("data", onData);
      socket.on("error", onError);
    });
  }

  close(): void {
    if (!this.socket) return;
    try {
      this.socket.write(Buffer.from([0, 0, 0, 0, 0]));
    } catch {
      /* the socket is already gone */
    }
    this.socket.destroy();
    this.socket = null;
    this.armed = null;
  }
}

/**
 * Ask a wrapper device service for the enhanced manifest of a song.
 *
 * The reference implementation needs this for hi-res masters: the account API
 * reports `enhancedHls` for most songs, but the top rendition is only offered to
 * the wrapper's own manifest endpoint.
 *
 * Protocol: [len][adamId] -> one line containing the manifest URL.
 */
export async function fetchDeviceManifest(
  adamId: string,
  address: string,
  timeoutMs = 10_000,
): Promise<string> {
  const options: net.NetConnectOpts = address.startsWith("unix:")
    ? { path: address.slice("unix:".length) }
    : (() => {
        const colon = address.lastIndexOf(":");
        return {
          host: address.slice(0, colon) || "127.0.0.1",
          port: Number.parseInt(address.slice(colon + 1), 10),
        };
      })();
  const socket = net.createConnection(options);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new LegacyDecryptorError("manifest service timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new LegacyDecryptorError(error.message));
    });
  });

  const id = Buffer.from(adamId, "utf8");
  if (id.length > 255) throw new LegacyDecryptorError("song id too long for the wire format");
  socket.write(Buffer.concat([Buffer.from([id.length]), id]));

  const response = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new LegacyDecryptorError("manifest service response timed out"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      resolve(buffer.slice(0, newline).trim());
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(new LegacyDecryptorError(error.message));
    });
  });
  socket.destroy();

  if (!/^https:\/\//i.test(response)) {
    throw new LegacyDecryptorError(`manifest service returned: ${response || "(empty)"}`);
  }
  return response;
}
