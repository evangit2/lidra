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
  // `cd` can follow a shell quote when the launch line is wrapped, as it is on
  // Windows: wsl.exe ... -- /bin/sh -c "cd '/opt/lidra' && exec ./wrapper ...".
  const cd = /(?:^|&&|;|["'])\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&;]+))/.exec(trimmed);
  if (cd) return cd[1] ?? cd[2] ?? cd[3] ?? null;
  const binary = /(?:^|&&|;)\s*(?:"([^"]+)"|'([^']+)'|([^\s&;]+\.?[^\s&;]*))/.exec(trimmed);
  const target = binary?.[1] ?? binary?.[2] ?? binary?.[3];
  if (!target) return null;
  return path.dirname(target);
}

/**
 * The path a Windows host uses to reach a file inside the imported distro.
 *
 * `\\wsl$\<distro>\...` is a real UNC path, so the ordinary fs calls keep
 * working while the wrapper still sees its own `/opt/...` layout.
 */
export function hostPathForWrapper(
  baseDir: string,
  platform: NodeJS.Platform = process.platform,
  distro = "LidraWrapper",
): string {
  if (platform !== "win32") return baseDir;
  if (!baseDir.startsWith("/")) return baseDir;
  const sep = String.fromCharCode(92); // backslash, without escaping games
  const relative = baseDir.replace(/^\/+/, "").split("/").join(sep);
  return `${sep}${sep}wsl$${sep}${distro}${sep}${relative}`;
}

/** Read `MUSIC_TOKEN` (and the storefront) the wrapper cached after signing in. */
export function readWrapperSession(baseDir: string | null): WrapperSession | null {
  if (!baseDir) return null;
  const root = hostPathForWrapper(baseDir);
  // The wrapper writes its session inside the Android data directory it chroots
  // into, not next to the launcher. Both layouts are checked because the
  // launcher's own base directory is where older builds put the token.
  const roots = [path.join(root, "rootfs", "data", "data", "com.apple.android.music", "files"), root];
  for (const candidate of roots) {
    let mediaUserToken: string;
    try {
      mediaUserToken = fs.readFileSync(path.join(candidate, "MUSIC_TOKEN"), "utf8").trim();
    } catch {
      continue;
    }
    if (!mediaUserToken) continue;
    let storefront: string | undefined;
    try {
      storefront = fs.readFileSync(path.join(candidate, "STOREFRONT_ID"), "utf8").trim() || undefined;
    } catch {
      storefront = undefined;
    }
    return { mediaUserToken, storefront };
  }
  return null;
}
