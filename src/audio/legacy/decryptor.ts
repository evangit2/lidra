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
/** Unread plaintext the service is allowed to have queued. */
const MAX_IN_FLIGHT = 256 * 1024;

/**
 * The wrapper caches one key context per song for the lifetime of its process,
 * and the first arm decides which key that context holds. Apple's playlists
 * open with a placeholder key (`P000000000/s1/e1`) that the reference client
 * addresses with the literal id `0` so the service takes its prefetch path.
 * Arming that segment with the real song id instead leaves the later, real key
 * unreachable and every later fragment decrypts to noise.
 */
const PREFETCH_KEY = /P0{9}\/s1\/e1$/;

export function isPrefetchKey(keyUri: string): boolean {
  return PREFETCH_KEY.test(keyUri);
}

/** Song id to send on the wire for the given request. */
export function armIdOf(request: { adamId: string; keyUri: string }): string {
  return isPrefetchKey(request.keyUri) ? "0" : request.adamId;
}

export class LegacyDecryptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyDecryptorError";
  }
}

export interface LegacyRequest {
  adamId: string;
  keyUri: string;
  /** cbcs block pattern from `tenc`: decrypt N blocks, skip M. 0/0 = whole span. */
  cryptByteBlock?: number;
  skipByteBlock?: number;
  /** 0 when the track uses a constant IV, so senc carries none. */
  perSampleIvSize?: number;
  /** Codec of the rendition, used to verify the decrypted frame headers. */
  codec?: string;
}

/** Serialises requests onto one connection: the service is stateful. */
export class LegacyDecryptor {
  private socket: net.Socket | null = null;
  private queue: Promise<void> = Promise.resolve();
  private armed: string | null = null;
  /** Bytes received but not yet consumed, kept across batch reads. */
  private leftover: Buffer = Buffer.alloc(0);
  private waiters: Array<{
    length: number;
    resolve: (buffer: Buffer) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

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
    socket.on("data", (chunk: Buffer) => {
      this.leftover = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
      this.pumpWaiters();
    });
    socket.on("error", (error: Error) => this.failWaiters(error.message));
    socket.on("close", () => this.failWaiters("decryptor closed the connection"));
    this.socket = socket;
    return socket;
  }

  private pumpWaiters(): void {
    while (this.waiters.length > 0 && this.leftover.length >= this.waiters[0].length) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      const head = this.leftover.subarray(0, waiter.length);
      this.leftover = this.leftover.subarray(waiter.length);
      waiter.resolve(Buffer.from(head));
    }
  }

  private failWaiters(message: string): void {
    const pending = this.waiters.splice(0);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new LegacyDecryptorError(message));
    }
  }

  private static sendString(socket: net.Socket, value: string): void {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > 255) throw new LegacyDecryptorError("string too long for the wire format");
    socket.write(Buffer.concat([Buffer.from([bytes.length]), bytes]));
  }

  /** Arm the service for one (song, key URI) pair. */
  private async arm(request: LegacyRequest): Promise<void> {
    const socket = await this.connect();
    // SwitchKeys (four zero bytes) only separates one key from the next; sending it
    // before the first arm makes the service drop the connection.
    if (this.armed) socket.write(Buffer.from([0, 0, 0, 0]));
    LegacyDecryptor.sendString(socket, armIdOf(request));
    LegacyDecryptor.sendString(socket, request.keyUri);
    await this.drain();
    this.armed = `${armIdOf(request)}\u0000${request.keyUri}`;
    legacyLog.info(`armed decryptor for ${armIdOf(request)} (${request.keyUri})`);
  }

  /**
   * Re-arm at a fragment boundary.
   *
   * The service keeps per-fragment state: the reference client sends a key-switch
   * marker plus both strings before every segment after the first. Arming once for
   * the whole track leaves later fragments decrypting against stale state, which
   * decodes as garbage.
   */
  async armFragment(request: LegacyRequest): Promise<void> {
    const task = this.queue.then(async () => {
      const socket = await this.connect();
      if (this.armed) socket.write(Buffer.from([0, 0, 0, 0]));
      LegacyDecryptor.sendString(socket, armIdOf(request));
      LegacyDecryptor.sendString(socket, request.keyUri);
      await this.drain();
      this.armed = `${armIdOf(request)}\u0000${request.keyUri}`;
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    await task;
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
      if (this.armed !== `${armIdOf(request)}\u0000${request.keyUri}`) {
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
    return this.readExact(length);
  }

  private readExact(length: number): Promise<Buffer> {
    if (!this.socket) return Promise.reject(new LegacyDecryptorError("decryptor is not connected"));
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new LegacyDecryptorError("decryptor response timed out"));
      }, this.timeoutMs);
      this.waiters.push({ length, resolve, reject, timer });
      this.pumpWaiters();
    });
  }

  /**
   * Decrypt many runs in one pass.
   *
   * One round trip per sample costs about a millisecond, which on a 15 s
   * fragment (703 samples) dominates start-up latency. The service answers
   * strictly in order, so the whole fragment can be written up front and read
   * back as it arrives.
   */
  async decryptBatch(runs: Buffer[], request: LegacyRequest): Promise<Buffer[]> {
    if (runs.length === 0) return [];
    const task = this.queue.then(async (): Promise<Buffer[]> => {
      if (this.armed !== `${armIdOf(request)}\u0000${request.keyUri}`) {
        // `arm` writes straight to the socket: chaining through the queue here
        // would wait on the very task doing the awaiting.
        await this.arm(request);
      }
      const socket = await this.connect();
      const outputs = runs.map((run) => Buffer.from(run));
      const lengths = runs.map((run) => run.length & ~0xf);
      for (const usable of lengths) {
        if (usable > MAX_CHUNK) throw new LegacyDecryptorError("chunk exceeds the service limit");
      }

      let writeIndex = 0;
      let readIndex = 0;
      let inFlight = 0;
      while (readIndex < runs.length) {
        // Keep a bounded window of unread plaintext: the service reads one
        // chunk per pass, so flooding it with a whole fragment desynchronises
        // the stream and it stops answering.
        while (writeIndex < runs.length && inFlight + lengths[writeIndex] <= MAX_IN_FLIGHT) {
          const usable = lengths[writeIndex];
          if (usable > 0) {
            const header = Buffer.alloc(4);
            header.writeUInt32LE(usable, 0);
            socket.write(header);
            socket.write(runs[writeIndex].subarray(0, usable));
            inFlight += usable;
          }
          writeIndex += 1;
        }
        if (lengths[readIndex] === 0) {
          readIndex += 1;
          continue;
        }
        const plain = await this.readExact(lengths[readIndex]);
        plain.copy(outputs[readIndex], 0);
        inFlight -= lengths[readIndex];
        readIndex += 1;
      }
      return outputs;
    });
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
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
    this.leftover = Buffer.alloc(0);
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
