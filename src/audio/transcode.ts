/**
 * Codec adaptation.
 *
 * Chromium decodes AAC and FLAC but not ALAC or E-AC-3, so a lossless or Dolby
 * rendition has to be repackaged before the page's media element can play it.
 * Both conversions are done by ffmpeg while the track is still arriving:
 *
 *   AAC          -> stream copy (no decode, no re-encode, no quality change)
 *   ALAC         -> FLAC (lossless, bit-exact)
 *   E-AC-3/AC-3  -> FLAC (decoded, multi-channel preserved)
 *
 * ffmpeg writes an HLS event playlist as it goes, which is exactly the shape
 * Lidra serves to the page: the first two seconds exist long before the track
 * has finished downloading.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import log from "electron-log/main";

const transcodeLog = log.scope("audio.transcode");

/** ffmpeg segment length. Short enough for a quick start, long enough to be cheap. */
export const HLS_SEGMENT_SECONDS = 2;

export type AudioTransform = "copy" | "flac";

export interface TranscodeOptions {
  /** Directory that receives playlist, init segment and media segments. */
  outputDir: string;
  /** `copy` for Chromium-decodable AAC, `flac` for ALAC and Dolby. */
  transform: AudioTransform;
  /** Source sample rate, used only to keep ffmpeg from guessing. */
  sampleRate?: number;
  /** ffmpeg binary; defaults to `LIDRA_FFMPEG` or `ffmpeg` on PATH. */
  ffmpegPath?: string;
}

export interface Transcoder {
  /** Write decrypted fMP4 bytes; resolves when ffmpeg accepted them. */
  write(chunk: Buffer): Promise<void>;
  /** Close stdin and wait for the muxer to flush. */
  finish(): Promise<void>;
  /** Abort immediately; partial output is discarded by the caller. */
  kill(): void;
  /** Playlist path, valid as soon as ffmpeg has written it. */
  readonly playlistPath: string;
  readonly exited: Promise<number | null>;
}

/**
 * ffmpeg that ships with the app.
 *
 * Chromium cannot decode ALAC or E-AC-3, so lossless and Dolby playback depend
 * on ffmpeg being present. Relying on the user's PATH would make those tiers
 * work on some machines and silently fail on others, so a build-time binary is
 * preferred and PATH is only the last resort. Inside an asar archive the binary
 * lives in app.asar.unpacked, which is where it can actually be executed.
 */
function bundledFfmpeg(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const resolved = require("ffmpeg-static") as string | null;
    if (!resolved) return null;
    const executable = resolved.includes("app.asar")
      ? resolved.replace("app.asar", "app.asar.unpacked")
      : resolved;
    if (!fs.existsSync(executable)) return null;
    // Verify it actually runs: a binary built for another architecture exists on
    // disk but fails to execute, and a silent failure here would look like a
    // codec problem later. Fall through to PATH in that case.
    const probe = spawnSync(executable, ["-version"], { timeout: 5000 });
    if (probe.error || probe.status !== 0) {
      transcodeLog.warn(
        `bundled ffmpeg is unusable (${probe.error?.message ?? `exit ${probe.status}`})`,
      );
      return null;
    }
    return executable;
  } catch {
    return null;
  }
}

/** Locate ffmpeg: explicit path, environment, bundled binary, then PATH. */
export function findFfmpeg(explicit?: string): string | null {
  const candidates = [explicit, process.env.LIDRA_FFMPEG, bundledFfmpeg(), "ffmpeg"].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      if (directory.length === 0) continue;
      const full = path.join(directory, candidate);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** Build the ffmpeg argument list for one track. */
export function buildFfmpegArgs(options: TranscodeOptions, playlistPath: string): string[] {
  const codec =
    options.transform === "copy"
      ? ["-c:a", "copy"]
      : [
          "-c:a",
          "flac",
          "-compression_level",
          "5",
          // Keep the source channel count: Atmos and Dolby Audio are 5.1.
          "-map",
          "0:a:0",
        ];

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "mov",
    "-i",
    "pipe:0",
    ...codec,
    "-f",
    "hls",
    "-hls_time",
    String(HLS_SEGMENT_SECONDS),
    "-hls_playlist_type",
    "event",
    "-hls_segment_type",
    "fmp4",
    "-hls_flags",
    "independent_segments+temp_file",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    path.join(options.outputDir, "seg%d.m4s"),
    playlistPath,
  ];
  return args;
}

/**
 * Start an ffmpeg process that muxes the decrypted fMP4 stream into HLS.
 *
 * Running ffmpeg before the first byte of media exists is deliberate: process
 * startup overlaps the network fetch, which removes it from the perceived
 * start latency.
 */
export function createTranscoder(options: TranscodeOptions): Transcoder {
  const playlistPath = path.join(options.outputDir, "playlist.m3u8");
  fs.mkdirSync(options.outputDir, { recursive: true });
  for (const entry of fs.readdirSync(options.outputDir)) {
    if (entry === "playlist.m3u8" || entry.endsWith(".m4s") || entry === "init.mp4") {
      fs.rmSync(path.join(options.outputDir, entry), { force: true });
    }
  }

  const ffmpegPath = findFfmpeg(options.ffmpegPath);
  if (!ffmpegPath) {
    throw new Error(
      "ffmpeg not found: install ffmpeg or set LIDRA_FFMPEG / Audio settings",
    );
  }

  const args = buildFfmpegArgs(options, playlistPath);
  transcodeLog.info(`ffmpeg ${args.join(" ")}`);
  const child: ChildProcess = spawn(ffmpegPath, args, {
    stdio: ["pipe", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        transcodeLog.error(`ffmpeg exited ${code}: ${stderr.trim().slice(-800)}`);
      }
      resolve(code);
    });
    child.on("error", (error) => {
      transcodeLog.error(`ffmpeg failed to start: ${error.message}`);
      resolve(null);
    });
  });

  const write = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!child.stdin || child.stdin.destroyed) {
        reject(new Error("ffmpeg input is closed"));
        return;
      }
      const accepted = child.stdin.write(chunk, (error) => {
        if (error) reject(error);
        else resolve();
      });
      if (!accepted) {
        child.stdin.once("drain", () => resolve());
      }
    });

  return {
    write,
    async finish(): Promise<void> {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      await exited;
    },
    kill(): void {
      child.kill("SIGKILL");
    },
    playlistPath,
    exited,
  };
}
