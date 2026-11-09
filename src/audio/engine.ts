/**
 * Audio engine: the part of Lidra that replaces Apple's DRM playback path.
 *
 * The page still decides what to play and drives the transport. When it asks for
 * a manifest, the engine holds that request, picks the song's best tier through
 * the vendored fairplay-decrypter backend, streams decrypted bytes into ffmpeg,
 * and answers with a loopback HLS playlist. The media element then plays those
 * bytes with the page's own transport code, so queueing, seeking, scrubbing and
 * the player bar behave exactly as they do upstream.
 */
import fs from "node:fs";
import path from "node:path";
import log from "electron-log/main";
import type { AudioVariant, QualityTier, SpatialMode } from "./hls";
import { TrackPipeline, listQualities, transformFor, type TrackAsset } from "./pipeline";
import { HlsServer, type TrackLocation } from "./server";
import type { FairplayEnv } from "./fairplay/service";

const engineLog = log.scope("audio.engine");

export interface AudioEngineOptions {
  fairplay: FairplayEnv;
  cacheRoot: string;
  getStorefront: () => string;
  getPreference: () => QualityTier | null;
  ffmpegPath?: string;
  /** How Atmos is presented; read per track so a settings change applies. */
  getSpatial?: () => SpatialMode;
  /** Called with a snapshot whenever a pipeline changes state. */
  onStateChange?: (snapshot: ReturnType<TrackPipeline["snapshot"]>) => void;
}

export interface EngineStatus {
  running: boolean;
  port: number;
  current: string | null;
  prepared: number;
  lastError?: string;
}

export class AudioEngine {
  private readonly server: HlsServer;
  private readonly pipelines = new Map<string, TrackPipeline>();
  private readonly appleToPipeline = new Map<string, string>();
  private currentAppleId: string | null = null;
  private redirectPending = false;
  private lastError: string | undefined;
  private preparation: Promise<void> | null = null;

  constructor(private readonly options: AudioEngineOptions) {
    this.server = new HlsServer({
      resolveTrack: (id) => this.locate(id),
    });
  }

  get isRunning(): boolean {
    return this.server.origin !== "http://127.0.0.1:0";
  }

  status(): EngineStatus {
    return {
      running: this.isRunning,
      port: this.isRunning ? Number.parseInt(this.server.origin.split(":").pop() ?? "0", 10) : 0,
      current: this.currentAppleId,
      prepared: this.pipelines.size,
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    await this.server.start();
  }

  async stop(): Promise<void> {
    for (const pipeline of this.pipelines.values()) pipeline.cancel();
    this.pipelines.clear();
    await this.server.stop();
  }

  /**
   * Called when the page announces a new now-playing item, before it starts
   * buffering. Resolution happens here so the manifest request finds a warm
   * pipeline.
   */
  markCurrent(appleId: string | null): void {
    this.currentAppleId = appleId;
    this.redirectPending = appleId !== null;
    // A failure belongs to the track that caused it; leaving it set made every
    // later track look failed while its preparation was still spinning up.
    this.lastError = undefined;
    if (appleId) void this.prepare(appleId).catch((error) => this.fail(error));
  }

  /** Resolve + download a track in the background without making it current. */
  prefetch(appleId: string): void {
    void this.prepare(appleId).catch(() => {
      /* prefetch failures must never surface as playback errors */
    });
  }

  /**
   * True when the next manifest request belongs to the current track and a
   * pipeline exists for it. Consumes the pending flag so retries by the player
   * still work (readiness never regresses for a prepared track).
   */
  takeRedirect(): boolean {
    if (!this.redirectPending) return false;
    this.redirectPending = false;
    return true;
  }

  /** Master playlist URL for the current track, once its playlist exists. */
  masterUrlForCurrent(): string | null {
    const appleId = this.currentAppleId;
    if (!appleId) return null;
    const pipelineId = this.appleToPipeline.get(appleId);
    if (!pipelineId) return null;
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline || !pipeline.isReady) return null;
    return this.server.masterUrl(pipelineId);
  }

  /**
   * Wait until the current track's playlist is on disk.
   *
   * The page's manifest fetch is held open for this, which is why startup feels
   * immediate: the first two seconds of audio are muxed while the request is in
   * flight, instead of after the whole file has downloaded.
   */
  async waitForCurrent(timeoutMs = 25_000): Promise<string | null> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      const url = this.masterUrlForCurrent();
      if (url) return url;
      if (this.lastError && this.preparation === null) return null;
      // Nothing is being prepared for this item (a library-only id, or the hook
      // never fired). Holding the player's own request for the full timeout is
      // what made library and playlist tracks sit silent.
      if (!this.preparation && Date.now() - started > 1_500) {
        engineLog.info("nothing to prepare for the current item; leaving playback to the player");
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    engineLog.warn("timed out waiting for the current track");
    return null;
  }

  private fail(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    engineLog.error(`audio pipeline failed: ${this.lastError}`);
  }

  private async prepare(appleId: string): Promise<void> {
    if (this.appleToPipeline.has(appleId)) {
      // Already prepared; make sure it is still warm.
      const pipeline = this.pipelines.get(this.appleToPipeline.get(appleId) as string);
      if (pipeline) return;
    }
    if (this.preparation) await this.preparation;

    const task = (async () => {
      const asset: TrackAsset = {
        id: appleId,
        storefront: this.options.getStorefront().toLowerCase(),
        name: appleId,
      };
      const preference = this.options.getPreference();

      const pipeline: TrackPipeline = new TrackPipeline({
        asset,
        onChange: () => this.emit(pipeline),
        preference,
        cacheRoot: this.options.cacheRoot,
        ffmpegPath: this.options.ffmpegPath,
        fairplay: this.options.fairplay,
        spatial: this.options.getSpatial?.() ?? "bed",
      });
      try {
        const prepared = await pipeline.prepare();
        this.pipelines.set(pipeline.id, pipeline);
        this.appleToPipeline.set(appleId, pipeline.id);
        engineLog.info(
          `prepared ${asset.id} — ${prepared.variant.tier} (${prepared.variant.codecs})`,
        );
        this.emit(pipeline);
        void pipeline
          .drain()
          .then(() => this.emit(pipeline))
          .catch(() => this.emit(pipeline));
      } catch (error) {
        pipeline.cancel();
        this.fail(error);
        throw error;
      }
    })();

    this.preparation = task.then(
      () => {
        this.preparation = null;
      },
      (error) => {
        // Clear first: waiters use "no preparation in flight" to decide whether
        // the player should be left alone.
        this.preparation = null;
        this.fail(error);
      },
    );
    await this.preparation;
  }

  /** List the renditions for a song without downloading it. */
  async qualities(appleId: string): Promise<AudioVariant[]> {
    return listQualities(this.options.fairplay, {
      id: appleId,
      storefront: this.options.getStorefront().toLowerCase(),
      name: appleId,
    });
  }

  private emit(pipeline: TrackPipeline): void {
    const snapshot = pipeline.snapshot();
    if (snapshot.error) this.lastError = snapshot.error;
    this.options.onStateChange?.(snapshot);
  }

  private locate(trackId: string): TrackLocation | null {
    const pipeline = this.pipelines.get(trackId);
    if (!pipeline) return null;
    const snapshot = pipeline.snapshot();
    const variant = snapshot.variant;
    if (!variant) return null;
    const directory = path.join(this.options.cacheRoot, trackId);
    if (!fs.existsSync(path.join(directory, "playlist.m3u8"))) return null;
    const transform = transformFor(variant.codecs);
    return {
      directory,
      codecs: transform === "copy" ? variant.codecs : "flac",
      bandwidth: Math.max(variant.bandwidth, 192_000),
      complete: snapshot.state === "complete",
    };
  }

  /** Paths are exposed for tests and for the settings pane's diagnostics. */
  static cacheRootFor(userDataPath: string): string {
    return path.join(userDataPath, "audio-cache");
  }
}

export type { QualityTier, AudioVariant };
