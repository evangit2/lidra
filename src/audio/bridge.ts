/**
 * Main-process wiring for the audio pipeline.
 *
 * Two jobs:
 *  1. Feed the engine with the page's now-playing item, so a track is resolved
 *     before the player asks for a manifest.
 *  2. Hold the player's manifest request while that track is prepared, then
 *     satisfy it from the loopback HLS server.
 */
import type { Session } from "electron";
import { ipcMain } from "electron";
import log from "electron-log/main";
import type { AudioEngine } from "./engine";

const bridgeLog = log.scope("audio.bridge");

/** Hosts whose `.m3u8` requests belong to the page's own player. */
const MEDIA_HOST_PATTERN = /^https:\/\/([a-z0-9-]+\.)*(apple|itunes|mzstatic)\.com\//i;

/** Anything that looks like an HLS playlist, including query-carrying URLs. */
export function isManifestRequest(url: string): boolean {
  if (!MEDIA_HOST_PATTERN.test(url)) return false;
  try {
    const parsed = new URL(url);
    return /\.m3u8/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Extract the catalog id of a now-playing payload sent by the page hook. */
export function catalogIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const playParams = record.playParams as Record<string, unknown> | undefined;
  const candidates = [playParams?.catalogId, playParams?.globalId, record.trackId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^\d+$/.test(candidate)) return candidate;
  }
  return null;
}

export interface AudioBridgeOptions {
  session: Session;
  engine: AudioEngine;
  /** How long the player's manifest request may be held open. */
  holdTimeoutMs?: number;
}

/**
 * Install the request interception that swaps Apple's manifest for Lidra's.
 *
 * A redirect is only attempted for the playlist request that follows a
 * now-playing change; every other request (radio, previews, artwork) is left
 * alone, so features Lidra cannot decrypt keep whatever behaviour they had.
 */
export function initAudioBridge(options: AudioBridgeOptions): void {
  const { session, engine } = options;
  const holdTimeoutMs = options.holdTimeoutMs ?? 20_000;

  session.webRequest.onBeforeRequest(
    { urls: ["*://*.apple.com/*", "*://*.itunes.com/*", "*://*.mzstatic.com/*"] },
    (details, callback) => {
      if (!isManifestRequest(details.url)) {
        callback({});
        return;
      }
      if (!engine.isRunning || !engine.takeRedirect()) {
        callback({});
        return;
      }
      void (async () => {
        const start = Date.now();
        const masterUrl = await engine.waitForCurrent(holdTimeoutMs);
        if (!masterUrl) {
          bridgeLog.warn(`no local stream for ${details.url}; leaving playback to the page`);
          callback({});
          return;
        }
        bridgeLog.info(
          `redirected manifest after ${Date.now() - start}ms -> ${masterUrl}`,
        );
        callback({ redirectURL: masterUrl });
      })().catch((error: unknown) => {
        bridgeLog.error(
          `manifest redirect failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        callback({});
      });
    },
  );

  ipcMain.on("nowPlayingItemDidChange", (_event, payload: unknown) => {
    const appleId = catalogIdFromPayload(payload);
    if (!appleId) {
      // Radio and other non-catalog items keep the page's own playback path.
      engine.markCurrent(null);
      return;
    }
    bridgeLog.info(`now playing ${appleId}`);
    engine.markCurrent(appleId);
  });
}
