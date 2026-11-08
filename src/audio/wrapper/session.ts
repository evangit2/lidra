/**
 * The wrapper's own session, reused for the web player.
 *
 * A store-services login yields a media-user-token, which is the same credential
 * music.apple.com uses for a signed-in session. Lidra therefore only needs one
 * sign-in: the wrapper authenticates once and the player adopts that token
 * instead of asking the user to type their Apple ID a second time.
 */
import fs from "node:fs";
import path from "node:path";

/** Credentials a running wrapper has cached on disk. */
export interface WrapperSession {
  mediaUserToken: string;
  storefront?: string;
}

/** Where the wrapper keeps its session, given the command that starts it. */
export function wrapperBaseDir(command: string | null | undefined): string | null {
  const trimmed = command?.trim();
  if (!trimmed) return null;
  // The supervisor runs the command through a shell, so `cd <dir> && ...` decides
  // the directory the wrapper writes its session into.
  const cd = /(?:^|&&|;)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&;]+))/.exec(trimmed);
  if (cd) return cd[1] ?? cd[2] ?? cd[3] ?? null;
  const binary = /(?:^|&&|;)\s*(?:"([^"]+)"|'([^']+)'|([^\s&;]+\.?[^\s&;]*))/.exec(trimmed);
  const target = binary?.[1] ?? binary?.[2] ?? binary?.[3];
  if (!target) return null;
  return path.dirname(target);
}

/** Read `MUSIC_TOKEN` (and the storefront) the wrapper cached after signing in. */
export function readWrapperSession(baseDir: string | null): WrapperSession | null {
  if (!baseDir) return null;
  const tokenPath = path.join(baseDir, "MUSIC_TOKEN");
  let mediaUserToken: string;
  try {
    mediaUserToken = fs.readFileSync(tokenPath, "utf8").trim();
  } catch {
    return null;
  }
  if (!mediaUserToken) return null;
  let storefront: string | undefined;
  try {
    storefront = fs.readFileSync(path.join(baseDir, "STOREFRONT_ID"), "utf8").trim() || undefined;
  } catch {
    storefront = undefined;
  }
  return { mediaUserToken, storefront };
}
