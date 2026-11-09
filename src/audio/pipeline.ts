/**
 * Per-track audio pipeline, FairPlay edition.
 *
 * One pipeline exists per song. It asks the vendored fairplay-decrypter
 * backend for the quality ladder, picks the best tier for the user's
 * preference, and pipes `fairplay stream` stdout (init + plaintext segments)
 * straight into ffmpeg, which writes the HLS event playlist the page plays.
 *
 * There is no fragment fetching, no key service, and no CDM here: the
 * backend owns download + decrypt + verify, and this module only adapts its
 * output to the loopback HLS server. Startup still overlaps — ffmpeg starts
 * before the first decrypted byte arrives.
 */
import crypto from "node:crypto";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import log from "electron-log/main";
import {
  rankVariants,
  selectVariant,
  type AudioVariant,
  type QualityTier,
  type SpatialMode,
} from "./hls";
import {
  inspectInitSegment,
  verifyAgainstVariant,
  type QualityCheck,
  type StreamFacts,
} from "./quality";
import { createTranscoder, type Transcoder, type AudioTransform } from "./transcode";
import {
  ladder as fairplayLadder,
  stream as fairplayStream,
  type FairplayEnv,
  type FairplayTier,
} from "./fairplay/service";

const pipelineLog = log.scope("audio.pipeline");

export type PipelineState = "preparing" | "streaming" | "complete" | "error";

/** Minimal song identity. The backend resolves everything else per track. */
export interface TrackAsset {
  id: string;
  storefront: string;
  name: string;
}

export interface PipelineOptions {
  asset: TrackAsset;
  preference: QualityTier | null;
  cacheRoot: string;
  ffmpegPath?: string;
  /** Force a transform instead of deriving it from the codec. */
  transformOverride?: AudioTransform;
  /** How Atmos should be presented: the 5.1 bed or Apple's binaural render. */
  spatial?: SpatialMode;
  /** Vendored backend environment (isolated state dirs, ports, runtime). */
  fairplay: FairplayEnv;
  /**
   * Called on every state change. The first decrypted bytes mark the track
   * as streaming, which is the moment the delivered quality becomes a fact
   * the UI can show; without this the badge only ever learned about failures.
   */
  onChange?: () => void;
}

export interface PipelineSnapshot {
  id: string;
  state: PipelineState;
  asset: TrackAsset;
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

/** Chromium cannot decode these, so they are repackaged to FLAC. */
export function transformFor(codecs: string): AudioTransform {
  const codec = codecs.toLowerCase();
  if (codec === "mp4a.40.2" || codec === "mp4a.40.5" || codec === "mp4a") {
    return "copy";
  }
  return "flac";
}

export function pipelineId(asset: TrackAsset, variant: AudioVariant | null): string {
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

function tierOf(id: string): QualityTier {
  if (id.startsWith("hirez192")) return "hi-res";
  if (id.startsWith("alac48")) return "lossless";
  if (id.startsWith("atmos")) return "atmos";
  return "aac";
}

/** Best-effort sample rate / bit depth from labels like "ALAC 192kHz/24-bit". */
function parseLabel(label: string): { sampleRate?: number; bitDepth?: number } {
  const m = /(\d+)\s*kHz\s*\/\s*(\d+)\s*-bit/i.exec(label);
  if (!m) return {};
  return { sampleRate: Number.parseInt(m[1], 10) * 1000, bitDepth: Number.parseInt(m[2], 10) };
}

function toVariant(tier: FairplayTier): AudioVariant {
  const { sampleRate, bitDepth } = parseLabel(tier.label);
  return {
    uri: tier.playlist,
    codecs: tier.codecs,
    audioGroup: tier.label,
    bandwidth: tier.bandwidth,
    tier: tierOf(tier.id),
    sampleRate,
    bitDepth,
    bitrateKbps: Math.round(tier.bandwidth / 1000),
    binaural: tier.id.endsWith("-bm"),
  } as AudioVariant;
}

export class TrackPipeline {
  readonly asset: TrackAsset;
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
  private bytesIn = 0;
  private readonly startedAt = Date.now();
  private transcoder: Transcoder | null = null;
  private child: ChildProcess | null = null;
  private cancelled = false;
  private running: Promise<void> | null = null;

  constructor(private readonly options: PipelineOptions) {
    this.asset = options.asset;
    this.preference = options.preference;
    this.spatial = options.spatial ?? "bed";
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
   * Pick a tier and start ffmpeg. Returns as soon as the playlist file
   * exists so the page can begin buffering; the backend keeps streaming in
   * the background via drain().
   */
  async prepare(): Promise<PreparedTrack> {
    if (isComplete(this.directory)) {
      // A previous run finished this track. Re-resolve the ladder cheaply
      // for the badge, and prefer the recorded source facts: the cached
      // init describes the repackaged output, not the tier Apple delivered.
      this.state = "complete";
      const tiers = await fairplayLadder(this.options.fairplay, this.asset.id).catch(() => []);
      const variants = rankVariants(tiers.map(toVariant));
      this.variant =
        selectVariant(variants, this.preference, { spatial: this.spatial }) ?? variants[0] ?? null;
      if (!this.variant) throw new Error("cached track lost its quality metadata");
      this.readCachedFacts(this.variant);
      pipelineLog.info(`cache hit ${this.asset.name} (${this.variant.audioGroup})`);
      return { directory: this.directory, mount: this.mount, variant: this.variant };
    }

    const tiers = await fairplayLadder(this.options.fairplay, this.asset.id);
    const variants = rankVariants(tiers.map(toVariant));
    const variant =
      selectVariant(variants, this.preference, { spatial: this.spatial }) ?? variants[0];
    if (!variant) throw new Error(`no playable tier for ${this.asset.id}`);
    this.variant = variant;

    const tierId = tiers.find(
      (t) => t.playlist === variant.uri && tierOf(t.id) === variant.tier,
    )?.id;
    if (!tierId) throw new Error(`tier for ${variant.tier} vanished mid-ladder`);

    fs.mkdirSync(this.directory, { recursive: true });
    const transcoder = createTranscoder({
      outputDir: this.directory,
      transform: this.options.transformOverride ?? transformFor(variant.codecs),
      sampleRate: variant.sampleRate,
      ffmpegPath: this.options.ffmpegPath,
    });
    this.transcoder = transcoder;

    const child = fairplayStream(this.options.fairplay, this.asset.id, tierId);
    this.child = child;
    pipelineLog.info(`streaming ${this.asset.name} -- ${variant.tier} (${variant.codecs})`);

    const head: Buffer[] = [];
    let headBytes = 0;
    const HEAD_CAP = 1 << 20;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.cancelled) return;
      this.bytesIn += chunk.length;
      if (!this.facts && headBytes < HEAD_CAP) {
        head.push(chunk);
        headBytes += chunk.length;
        try {
          const facts = inspectInitSegment(Buffer.concat(head));
          this.facts = facts;
          this.check = verifyAgainstVariant(variant, facts);
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
            pipelineLog.warn(`quality mismatch: ${this.check.mismatches.join("; ")}`);
          }
        } catch {
          /* moov not fully arrived yet */
        }
      }
      void transcoder.write(chunk).catch((e: unknown) => {
        if (!this.cancelled) this.fail(e);
      });
      if (this.state === "preparing" && fs.existsSync(transcoder.playlistPath)) {
        this.state = "streaming";
        this.emit();
      }
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    this.running = new Promise<void>((resolve, reject) => {
      child.on("error", (e) => {
        if (!this.cancelled) {
          this.fail(e);
          reject(e);
        } else resolve();
      });
      child.on("close", (code) => {
        if (this.cancelled) {
          resolve();
          return;
        }
        if (code !== 0) {
          const error = new Error(
            `decrypter exited ${code}: ${stderr.trim().slice(-300) || "no output"}`,
          );
          this.fail(error);
          reject(error);
          return;
        }
        transcoder
          .finish()
          .then(() => {
            this.state = "complete";
            this.emit();
            pipelineLog.info(
              `complete ${this.asset.name} (${variant.audioGroup}) in ${Date.now() - this.startedAt}ms`,
            );
          })
          .then(resolve, (e: unknown) => {
            this.fail(e);
            reject(e instanceof Error ? e : new Error(String(e)));
          });
      });
    });
    // Wait only for the playlist to exist, not the whole track.
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(transcoder.playlistPath)) {
      if (this.failure) throw new Error(this.failure);
      if (Date.now() > deadline) throw new Error("timed out waiting for first audio");
      await new Promise((r) => setTimeout(r, 100));
    }
    this.state = "streaming";
    this.emit();
    return { directory: this.directory, mount: this.mount, variant };
  }

  /**
   * Recover the delivered-quality facts for a cached track.
   *
   * The cached init segment describes what is served, so the source facts
   * recorded when the track was first decrypted are preferred — the badge
   * should name the tier Apple delivered, not the container it was
   * repackaged into.
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

  /** Wait for the current download to finish (or fail). */
  async drain(): Promise<void> {
    if (this.running) await this.running;
  }

  /** Abort the stream and tear down ffmpeg. */
  cancel(): void {
    this.cancelled = true;
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      this.transcoder?.kill();
    } catch {
      /* already gone */
    }
  }

  private fail(error: unknown): void {
    if (this.state !== "error") {
      this.failure = error instanceof Error ? error.message : String(error);
      this.state = "error";
      pipelineLog.error(`track ${this.asset.id} failed: ${this.failure}`);
      this.emit();
    }
  }

  private emit(): void {
    try {
      this.options.onChange?.();
    } catch (notifyError) {
      pipelineLog.warn(`state listener failed: ${String(notifyError)}`);
    }
  }
}

/** Resolve a track's renditions without downloading any media. */
export async function listQualities(
  fairplay: FairplayEnv,
  asset: TrackAsset,
): Promise<AudioVariant[]> {
  const tiers = await fairplayLadder(fairplay, asset.id);
  return rankVariants(tiers.map(toVariant));
}

/** Exported for tests: resolve a pipeline's URL without touching the network. */
export function pipelinePaths(cacheRoot: string, asset: TrackAsset, variant: AudioVariant) {
  const id = pipelineId(asset, variant);
  const directory = path.join(cacheRoot, id);
  return {
    id,
    directory,
    playlist: path.join(directory, "playlist.m3u8"),
    init: path.join(directory, "init.mp4"),
  };
}
