/**
 * Per-track audio pipeline.
 *
 * One pipeline exists per (song, quality) pair. It resolves the enhanced HLS
 * manifest, downloads the encrypted fMP4 fragments, decrypts them with keys
 * from the configured key service, and hands the plaintext to ffmpeg, which
 * writes an HLS event playlist the page can play immediately.
 *
 * Fragments are handled as they arrive rather than after the whole file has
 * downloaded: a hi-res song is over 100 MB, and waiting for all of it is what
 * makes naive implementations feel slow.
 */
import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import log from "electron-log/main";
import type { SongAsset } from "./catalog";
import { fetchStream, fetchText } from "./catalog";
import {
  parseMasterPlaylist,
  parseMediaPlaylist,
  rankVariants,
  selectVariant,
  type SpatialMode,
  rangeHeader,
  type AudioVariant,
  type MediaPlaylist,
  type QualityTier,
} from "./hls";
import type { KeyCache } from "./keys";
import { rewriteInit } from "./mp4/init";
import { decryptSegment } from "./mp4/segment";
import { inspectInitSegment, verifyAgainstVariant, type QualityCheck, type StreamFacts } from "./quality";
import { createTranscoder, type Transcoder, type AudioTransform } from "./transcode";
import { LegacyDecryptor, fetchDeviceManifest } from "./legacy/decryptor";
import { DecryptMismatchError, decryptSegmentLegacy } from "./legacy/segment";

const pipelineLog = log.scope("audio.pipeline");

export type PipelineState = "preparing" | "streaming" | "complete" | "error";

export interface PipelineOptions {
  asset: SongAsset;
  preference: QualityTier | null;
  keyCache: KeyCache;
  cacheRoot: string;
  ffmpegPath?: string;
  /** Force a transform instead of deriving it from the codec. */
  transformOverride?: AudioTransform;
  /**
   * `key` decrypts locally with key material from the key service; `wrapper`
   * sends ciphertext to a wrapper decrypt socket and never sees a key.
   */
  decryptMode?: "key" | "wrapper";
  /** Wrapper decrypt socket address, used when `decryptMode` is `wrapper`. */
  decryptorService?: string;
  /**
   * Live wrapper address. The service is free to move to a free port pair when a
   * previous run's process still owns the configured one, so read it per track.
   */
  decryptorAddress?: () => string;
  /** Live wrapper manifest address, read per track for the same reason. */
  manifestAddress?: () => string;
  /** Wrapper manifest socket address; overrides the API's manifest when set. */
  manifestService?: string;
  /**
   * Restart the wrapper service. A wrapper process pins one key context per
   * song, so a context armed before the song's keys were available yields noise;
   * a fresh process resolves it.
   */
  restartDecryptor?: () => Promise<void>;
  /** How Atmos should be presented: the 5.1 bed or Apple's binaural render. */
  spatial?: SpatialMode;
  /**
   * Resolver for the Widevine-keyed web-playback asset. Used when the chosen
   * rendition is FairPlay-only, which every lossless and Atmos rendition is.
   */
  webPlayback?: (adamId: string) => Promise<{ text: string; baseUrl: string } | null>;
  /**
   * Called on every state change. The first decrypted fragment marks the track
   * as streaming, which is the moment the delivered quality becomes a fact the
   * UI can show; without this the badge only ever learned about failures.
   */
  onChange?: () => void;
}

export interface PipelineSnapshot {
  id: string;
  state: PipelineState;
  asset: SongAsset;
  variant: AudioVariant | null;
  error?: string;
  bytesIn: number;
  startedAt: number;
  /** Codec configuration read out of the initialisation segment. */
  facts?: StreamFacts | null;
  /** Whether what arrived matches what the manifest promised. */
  check?: QualityCheck | null;
}

export interface PreparedTrack {
  /** Directory holding playlist.m3u8, init.mp4 and segN.m4s. */
  directory: string;
  /** Path fragment the local server mounts this track under. */
  mount: string;
  variant: AudioVariant;
}

/** True when `host:port` accepts a connection within `timeoutMs`. */
function socketOpen(address: string | undefined, timeoutMs = 600): Promise<boolean> {
  const trimmed = address?.trim();
  if (!trimmed) return Promise.resolve(false);
  const colon = trimmed.lastIndexOf(":");
  const port = Number.parseInt(trimmed.slice(colon + 1), 10);
  if (colon === -1 || !Number.isInteger(port)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: trimmed.slice(0, colon) || "127.0.0.1", port });
    const done = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Chromium cannot decode these, so they are repackaged to FLAC. */
export function transformFor(codecs: string): AudioTransform {
  const codec = codecs.toLowerCase();
  if (codec === "mp4a.40.2" || codec === "mp4a.40.5" || codec === "mp4a") {
    return "copy";
  }
  return "flac";
}

export function pipelineId(asset: SongAsset, variant: AudioVariant | null): string {
  const descriptor = variant
    ? `${variant.tier}-${variant.codecs}-${variant.sampleRate ?? 0}-${variant.bitDepth ?? 0}-${variant.bitrateKbps ?? 0}`
    : "unresolved";
  return crypto
    .createHash("sha1")
    .update(`${asset.storefront}:${asset.id}:${descriptor}`)
    .digest("hex")
    .slice(0, 20);
}

/** True when a previous run left a complete playlist on disk. */
function isComplete(directory: string): boolean {
  try {
    const playlist = fs.readFileSync(path.join(directory, "playlist.m3u8"), "utf8");
    return playlist.includes("#EXT-X-ENDLIST");
  } catch {
    return false;
  }
}


/** The init-segment reader returns either the whole info object or just the map. */
function encryptionOf(info: unknown): {
  cryptByteBlock?: number;
  skipByteBlock?: number;
  perSampleIvSize?: number;
} {
  const value = info as {
    encryption?: { cryptByteBlock?: number; skipByteBlock?: number; perSampleIvSize?: number };
  };
  if (value?.encryption) return value.encryption;
  return (info ?? {}) as {
    cryptByteBlock?: number;
    skipByteBlock?: number;
    perSampleIvSize?: number;
  };
}

export class TrackPipeline {
  readonly asset: SongAsset;
  readonly preference: QualityTier | null;
  readonly id: string;
  readonly mount: string;
  readonly directory: string;

  private state: PipelineState = "preparing";
  private facts: StreamFacts | null = null;
  private check: QualityCheck | null = null;
  private failure: string | undefined;
  private variant: AudioVariant | null = null;
  private readonly spatial: SpatialMode;
  /** Mode actually used for this track: a wrapper that is down is a key source. */
  private effectiveMode: "key" | "wrapper";
  private tee: import("node:fs").WriteStream | null = null;
  private bytesIn = 0;
  private readonly startedAt = Date.now();
  private transcoder: Transcoder | null = null;
  private legacy: LegacyDecryptor | null = null;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: PipelineOptions) {
    this.asset = options.asset;
    this.preference = options.preference;
    this.spatial = options.spatial ?? "bed";
    this.effectiveMode = options.decryptMode ?? "key";
    this.id = pipelineId(options.asset, null);
    this.mount = `/track/${this.id}`;
    this.directory = path.join(options.cacheRoot, this.id);
  }

  snapshot(): PipelineSnapshot {
    return {
      id: this.id,
      state: this.state,
      asset: this.asset,
      variant: this.variant,
      error: this.failure,
      bytesIn: this.bytesIn,
      startedAt: this.startedAt,
      facts: this.facts,
      check: this.check,
    };
  }

  get isReady(): boolean {
    return this.state === "streaming" || this.state === "complete";
  }

  /**
   * Resolve the manifest and start ffmpeg. Returns as soon as the playlist file
   * exists so the page can begin buffering; the download continues in the
   * background.
   */
  /** Resolve the master playlist, preferring the wrapper manifest when configured. */
  private async masterManifest(): Promise<{ text: string; baseUrl: string }> {
    const service = (this.options.manifestAddress?.() ?? this.options.manifestService ?? "").trim();
    if (service) {
      try {
        const url = await fetchDeviceManifest(this.asset.id, service);
        return { text: await fetchText(url), baseUrl: url };
      } catch (error) {
        pipelineLog.warn(
          `wrapper manifest unavailable (${error instanceof Error ? error.message : String(error)}); using the account API`,
        );
      }
    }
    return { text: await fetchText(this.asset.manifestUrl), baseUrl: this.asset.manifestUrl };
  }

  /**
   * Recover the delivered-quality facts for a cached track.
   *
   * The cached init segment describes what is served (often FLAC, which carries
   * no bit depth in its codec configuration), so the source facts recorded when
   * the track was first decrypted are preferred — the badge should name the tier
   * Apple delivered, not the container it was repackaged into.
   */
  private readCachedFacts(variant: AudioVariant): void {
    try {
      const recorded = JSON.parse(
        fs.readFileSync(path.join(this.directory, "quality.json"), "utf8"),
      ) as { facts?: StreamFacts | null; check?: QualityCheck | null };
      if (recorded.facts) {
        this.facts = recorded.facts;
        this.check = recorded.check ?? verifyAgainstVariant(variant, recorded.facts);
        return;
      }
    } catch {
      // No record from the first play: fall back to the init segment on disk.
    }
    try {
      const init = fs.readFileSync(path.join(this.directory, "init.mp4"));
      this.facts = inspectInitSegment(init);
      this.check = verifyAgainstVariant(variant, this.facts);
    } catch (error) {
      pipelineLog.warn(
        `cached quality facts unavailable for ${this.asset.name}: ${String(error)}`,
      );
    }
  }

  /** Address of the decryptor to talk to for this track. */
  private decryptorService(): string {
    return (this.options.decryptorAddress?.() ?? this.options.decryptorService ?? "").trim();
  }

  async prepare(): Promise<PreparedTrack> {
    if (isComplete(this.directory)) {
      this.state = "complete";
      const playlist = await this.masterManifest()
        .then((master) => master.text)
        .catch(() => "");
      this.variant = playlist
        ? (selectVariant(
            parseMasterPlaylist(playlist, this.asset.manifestUrl),
            this.preference,
            { spatial: this.spatial },
          ) ?? null)
        : null;
      if (!this.variant) throw new Error("cached track lost its quality metadata");
      // A cached track never streams again, so the measured facts have to come
      // from the init segment already on disk — otherwise the badge has nothing
      // to show for anything played from the cache.
      this.readCachedFacts(this.variant);
      pipelineLog.info(`cache hit ${this.asset.name} (${this.variant.label})`);
      return { directory: this.directory, mount: this.mount, variant: this.variant };
    }

    if (this.effectiveMode === "wrapper") {
      const open = await socketOpen(this.decryptorService());
      if (!open) {
        pipelineLog.warn(
          `wrapper is not answering on ${this.decryptorService() || "?"}; using the key source for this track`,
        );
        this.effectiveMode = "key";
      }
    }

    const master = await this.masterManifest();
    const variants = rankVariants(parseMasterPlaylist(master.text, master.baseUrl));
    if (variants.length === 0) {
      throw new Error("manifest listed no audio renditions");
    }
    let variant = selectVariant(variants, this.preference, { spatial: this.spatial });
    if (!variant) throw new Error("no rendition matched the quality preference");

    // Lossless and Atmos renditions are FairPlay-only. A wrapper decrypts those;
    // without one the only key Apple offers a web session is Widevine on the
    // 256 kbps web-playback asset, so fall back to it rather than fail at the
    // first segment.
    if (this.effectiveMode !== "wrapper" && this.options.webPlayback) {
      const keyUri = await this.firstKeyUri(variant);
      if (keyUri.startsWith("skd://")) {
        const fallback = await this.options.webPlayback(this.asset.id).catch(() => null);
        if (fallback) {
          const fallbackVariants = rankVariants(
            parseMasterPlaylist(fallback.text, fallback.baseUrl),
          );
          const picked = selectVariant(fallbackVariants, this.preference, { spatial: this.spatial });
          if (picked) {
            pipelineLog.info(
              `${this.asset.name}: ${variant.label} is FairPlay-only; using ${picked.label} with a Widevine key`,
            );
            variant = picked;
          }
        }
      }
    }
    this.variant = variant;

    this.transcoder = createTranscoder({
      outputDir: this.directory,
      transform: this.options.transformOverride ?? transformFor(variant.codecs),
      sampleRate: variant.sampleRate,
      ffmpegPath: this.options.ffmpegPath,
    });

    this.running = this.pump(variant);
    return { directory: this.directory, mount: this.mount, variant };
  }

  /** The key URI the rendition's media playlist declares, if any. */
  private async firstKeyUri(variant: AudioVariant): Promise<string> {
    try {
      const playlist = parseMediaPlaylist(await fetchText(variant.uri), variant.uri);
      return playlist.segments[0]?.key?.uri ?? "";
    } catch (error) {
      pipelineLog.warn(
        `could not read the key URI for ${variant.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "";
    }
  }

  /** Wait for the current download to finish (or fail). */
  async drain(): Promise<void> {
    await this.running;
  }

  private setState(state: PipelineState, error?: string): void {
    this.state = state;
    if (error) {
      this.failure = error;
      pipelineLog.error(`${this.asset.name}: ${error}`);
    }
    try {
      this.options.onChange?.();
    } catch (notifyError) {
      pipelineLog.warn(`state listener failed: ${String(notifyError)}`);
    }
  }

  private async pump(variant: AudioVariant): Promise<void> {
    const transcoder = this.transcoder;
    if (!transcoder) throw new Error("pipeline started without a transcoder");
    this.abort = new AbortController();
    try {
      const playlistText = await fetchText(variant.uri);
      const playlist = parseMediaPlaylist(playlistText, variant.uri);
      if (playlist.segments.length === 0) throw new Error("media playlist had no segments");

      // The initialisation segment carries the sample entry and the encryption
      // parameters; rewrite it once and feed the plaintext version to ffmpeg.
      if (!playlist.map) throw new Error("media playlist has no EXT-X-MAP initialiser");
      const initResponse = await fetchStream(playlist.map.uri, {
        range: playlist.map.byterange ? rangeHeader(playlist.map.byterange) : undefined,
        signal: this.abort.signal,
      });
      const encryptedInit = Buffer.from(await initResponse.arrayBuffer());

      // The init segment is in the clear, so the delivered quality can be proven
      // before a single sample is decrypted.
      try {
        this.facts = inspectInitSegment(encryptedInit);
        this.check = verifyAgainstVariant(variant, this.facts);
        // Remember the source facts: the cached init describes the repackaged
        // output, which is not the tier Apple delivered.
        try {
          fs.writeFileSync(
            path.join(this.directory, "quality.json"),
            JSON.stringify({ facts: this.facts, check: this.check }, null, 2),
          );
        } catch {
          // A missing record only costs the badge on the next cached play.
        }
        if (this.check.ok) {
          pipelineLog.info(`verified ${this.check.label} for ${this.asset.name}`);
        } else {
          pipelineLog.warn(
            `quality mismatch for ${this.asset.name}: ${this.check.mismatches.join("; ")}`,
          );
        }
      } catch (error) {
        pipelineLog.warn(
          `could not inspect the init segment for ${this.asset.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const { init: plainInit, info } = rewriteInit(encryptedInit);
      await transcoder.write(plainInit);
      if (process.env.LIDRA_TEE_DIR) {
        // Diagnostic: keep exactly what ffmpeg is fed so a bad timeline can be
        // reproduced offline.
        this.tee = fs.createWriteStream(path.join(process.env.LIDRA_TEE_DIR, "input.bin"));
        this.tee.write(plainInit);
      }

      for (const segment of playlist.segments) {
        const isEncrypted = Boolean(segment.key?.uri);
        const keyUri = segment.key?.uri ?? "";
        const response = await fetchStream(segment.uri, {
          range: segment.byterange ? rangeHeader(segment.byterange) : undefined,
          signal: this.abort.signal,
        });
        const encrypted = Buffer.from(await response.arrayBuffer());
        this.bytesIn += encrypted.length;
        const plain = isEncrypted
          ? await this.decrypt(encrypted, keyUri, info)
          : encrypted;
        await transcoder.write(plain);
        this.tee?.write(plain);
        if (this.state === "preparing") this.setState("streaming");
      }

      await transcoder.finish();
      this.tee?.end();
      this.tee = null;
      this.setState("complete");
      pipelineLog.info(
        `complete ${this.asset.name} (${variant.label}) in ${Date.now() - this.startedAt}ms`,
      );
    } catch (error) {
      if (this.abort.signal.aborted) {
        this.setState("error", "cancelled");
      } else {
        this.setState("error", error instanceof Error ? error.message : String(error));
      }
      transcoder.kill();
    }
  }

  /** Decrypt one fragment with whichever transport is configured. */
  private async decrypt(
    segment: Buffer,
    keyUri: string,
    info: Parameters<typeof decryptSegment>[2],
  ): Promise<Buffer> {
    if (this.effectiveMode === "wrapper") {
      const service = this.decryptorService();
      if (!service) throw new Error("wrapper decrypt mode needs a decryptor service address");
      const request = {
        adamId: this.asset.id,
        keyUri,
        cryptByteBlock: encryptionOf(info).cryptByteBlock,
        skipByteBlock: encryptionOf(info).skipByteBlock,
        perSampleIvSize: encryptionOf(info).perSampleIvSize,
        codec: this.variant?.codecs,
      };
      const decryptor = (this.legacy ??= new LegacyDecryptor(service));
      try {
        return await decryptSegmentLegacy(segment, decryptor, request);
      } catch (error) {
        // The service pins one key context per song per process, so a context
        // that was armed before this song's keys were reachable returns noise
        // rather than failing. A fresh process picks the right one, so this is
        // recoverable: restart the service and try the fragment once more.
        if (error instanceof DecryptMismatchError && this.options.restartDecryptor) {
          pipelineLog.warn(
            `decryptor returned unexpected plaintext (${error.message}); restarting it`,
          );
          this.legacy?.close();
          this.legacy = null;
          try {
            await this.options.restartDecryptor();
            const fresh = (this.legacy ??= new LegacyDecryptor(service));
            return await decryptSegmentLegacy(segment, fresh, request);
          } catch (retryError) {
            pipelineLog.warn(
              `decryptor restart did not help: ${
                retryError instanceof Error ? retryError.message : String(retryError)
              }`,
            );
          }
        }
        // A FairPlay key URI is useless to the key service: asking it for a
        // Widevine licence on an skd:// URI earns a -1003 refusal that hides
        // the real problem. Say what actually happened instead.
        if (keyUri.startsWith("skd://")) {
          throw new Error(
            "lossless playback needs the wrapper's key session; sign in again from Settings → Audio",
          );
        }
        // A wrapper that is configured but not running (not signed in yet, or
        // stopped) must not take playback down with it: fall back to the key
        // source, which reaches the Widevine rendition.
        pipelineLog.warn(
          `wrapper decrypt failed (${error instanceof Error ? error.message : String(error)}); trying the key source`,
        );
        const key = await this.resolveKey(keyUri);
        if (!key) throw error;
        pipelineLog.warn(
          `wrapper unavailable (${error instanceof Error ? error.message : String(error)}); decrypting with the key source`,
        );
        this.effectiveMode = "key";
        this.legacy?.close();
        this.legacy = null;
        return decryptSegment(segment, key, info);
      }
    }
    const key = await this.resolveKey(keyUri);
    return key ? decryptSegment(segment, key, info) : segment;
  }

  private async resolveKey(keyUri: string | undefined): Promise<Buffer | null> {
    if (!keyUri) return null;
    // Apple hands out `skd://` for FairPlay and `data:…` PSSH blobs for
    // Widevine. The key service understands both; Lidra only needs the key.
    return this.options.keyCache.get({
      adamId: this.asset.id,
      keyUri,
      storefront: this.asset.storefront,
    });
  }

  /** Abort the download and tear down ffmpeg. */
  cancel(): void {
    this.abort?.abort();
    this.transcoder?.kill();
    this.legacy?.close();
  }
}

/** Resolve a track's renditions without downloading any media. */
export async function listQualities(asset: SongAsset): Promise<AudioVariant[]> {
  const masterText = await fetchText(asset.manifestUrl);
  return rankVariants(parseMasterPlaylist(masterText, asset.manifestUrl));
}

/** Exported for tests: resolve a pipeline's URL without touching the network. */
export function pipelinePaths(cacheRoot: string, asset: SongAsset, variant: AudioVariant) {
  const id = pipelineId(asset, variant);
  const directory = path.join(cacheRoot, id);
  return {
    id,
    directory,
    playlist: path.join(directory, "playlist.m3u8"),
    init: path.join(directory, "init.mp4"),
  };
}
