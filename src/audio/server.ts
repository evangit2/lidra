/**
 * Loopback HLS server.
 *
 * The page's own media element plays Apple Music's HLS manifests, so Lidra
 * replaces the manifest it would have used with one served from here. That keeps
 * the page's transport, buffering, seeking and queue logic — and therefore the
 * whole UI — exactly as upstream, while the bytes come from the local pipeline
 * instead of a DRM-protected CDN stream.
 *
 * Bound to 127.0.0.1 and gated by a random per-run token in the path.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import log from "electron-log/main";

const serverLog = log.scope("audio.server");

const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m4s": "video/mp4",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
};

export interface TrackLocation {
  /** Directory holding playlist.m3u8, init.mp4 and the media segments. */
  directory: string;
  /** Master playlist CODECS attribute describing what is actually muxed. */
  codecs: string;
  /** Peak bandwidth to advertise, in bits per second. */
  bandwidth: number;
  /** True once the track is fully muxed. */
  complete: boolean;
}

export interface HlsServerOptions {
  /** Maps a track id to its on-disk location, or null when unknown. */
  resolveTrack: (id: string) => TrackLocation | null;
  host?: string;
}

export class HlsServer {
  private server: http.Server | null = null;
  private port = 0;
  readonly token = crypto.randomBytes(12).toString("hex");

  constructor(private readonly options: HlsServerOptions) {}

  get origin(): string {
    return `http://${this.options.host ?? "127.0.0.1"}:${this.port}`;
  }

  /** URL the page is redirected to for a given track. */
  masterUrl(trackId: string): string {
    return `${this.origin}/${this.token}/${trackId}/master.m3u8`;
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer((request, response) => {
      try {
        this.handle(request, response);
      } catch (error) {
        serverLog.error(`request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) response.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, this.options.host ?? "127.0.0.1", () => resolve());
    });
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    this.server = server;
    serverLog.info(`serving on ${this.origin}`);
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The page is an https origin, so every response needs explicit CORS. */
  private corsHeaders(request: http.IncomingMessage): http.OutgoingHttpHeaders {
    const origin = request.headers.origin;
    const allowed =
      typeof origin === "string" && /^https:\/\/[a-z0-9.-]*apple\.com$/.test(origin)
        ? origin
        : "*";
    return {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Accept, Content-Type, Origin",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    const cors = this.corsHeaders(request);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    if (parts.length !== 3 || parts[0] !== this.token) {
      response.writeHead(404).end();
      return;
    }
    const [, trackId, file] = parts;
    const location = this.options.resolveTrack(trackId);
    if (!location) {
      // The page may ask before the pipeline has registered the track; HLS
      // players retry, so answer with a retryable status rather than an error.
      response.writeHead(503, { "Retry-After": "1" }).end();
      return;
    }

    if (file === "master.m3u8") {
      const body = this.masterPlaylist(trackId, location);
      response.writeHead(200, {
        ...cors,
        "Content-Type": CONTENT_TYPES[".m3u8"],
        "Cache-Control": "no-store",
      });
      response.end(body);
      return;
    }

    if (file === "media.m3u8") {
      this.serveFile(path.join(location.directory, "playlist.m3u8"), request, response, {
        rewrite: (text) => this.rewritePlaylist(text),
        contentType: CONTENT_TYPES[".m3u8"],
        missingStatus: 503,
        cors,
      });
      return;
    }

    if (!/^(init\.mp4|seg\d+\.m4s)$/.test(file)) {
      response.writeHead(404).end();
      return;
    }
    const extension = path.extname(file);
    this.serveFile(path.join(location.directory, file), request, response, {
      contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
      // Finished tracks never change; in-progress segments are written once and
      // then left alone, so caching is safe for both.
      immutable: true,
      cors,
    });
  }

  private masterPlaylist(trackId: string, location: TrackLocation): string {
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      `#EXT-X-STREAM-INF:BANDWIDTH=${location.bandwidth},CODECS="${location.codecs}"`,
      `media.m3u8`,
      "",
    ];
    serverLog.info(`master playlist for ${trackId} (${location.codecs})`);
    return lines.join("\n");
  }

  /** Force playlists to be re-read while a track is still being muxed. */
  private rewritePlaylist(text: string): string {
    return text;
  }

  private serveFile(
    filePath: string,
    request: http.IncomingMessage,
    response: http.ServerResponse,
    options: {
      rewrite?: (text: string) => string;
      contentType: string;
      missingStatus?: number;
      immutable?: boolean;
      cors?: http.OutgoingHttpHeaders;
    },
  ): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      response.writeHead(options.missingStatus ?? 404, { "Retry-After": "1" }).end();
      return;
    }

    const headers: http.OutgoingHttpHeaders = {
      ...options.cors,
      "Content-Type": options.contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": options.immutable ? "public, max-age=86400, immutable" : "no-store",
    };

    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] === "" ? 0 : Number.parseInt(match[1], 10);
        const end = match[2] === "" ? stat.size - 1 : Number.parseInt(match[2], 10);
        if (start > end || end >= stat.size) {
          response.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end();
          return;
        }
        headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
        headers["Content-Length"] = end - start + 1;
        response.writeHead(206, headers);
        fs.createReadStream(filePath, { start, end }).pipe(response);
        return;
      }
    }

    if (options.rewrite) {
      const body = options.rewrite(fs.readFileSync(filePath, "utf8"));
      headers["Content-Length"] = Buffer.byteLength(body);
      response.writeHead(200, headers);
      response.end(body);
      return;
    }

    headers["Content-Length"] = stat.size;
    response.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(response);
  }
}
