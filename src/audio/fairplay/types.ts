/** Shared types for the vendored fairplay-decrypter backend. */

export interface FairplayStatus {
  service: "running" | "stopped";
  install: string | null;
  session: "signed in" | "not signed in";
  storefront: string | null;
  device: string;
}

export interface FairplayTier {
  id: string;
  label: string;
  codecs: string;
  bandwidth: number;
  playlist: string;
}

export interface FairplayAccount {
  storefront_id: string;
  dev_token: string;
  music_token: string;
}

export interface FairplayPaths {
  /** Directory holding fairplay_decrypter/__main__.py + libs/. */
  packageDir: string;
  /** Writable per-app state root (Electron userData or equivalent). */
  stateDir: string;
}

export interface FairplayWsl {
  distro: string;
  /** Linux python inside the distro, e.g. /opt/python/python3. */
  python: string;
}

export interface FairplayEnv {
  PYTHON: string;
  packageDir: string;
  dataDir: string;
  configDir: string;
  serviceDir: string | null;
  ports: { decrypt: number; manifest: number; account: number; key: number };
  /** Pass FPDECRYPT_NO_SUDO (userns hosts keep no passwordless sudo). */
  noSudo?: boolean;
  /** Set on Windows: spawn through wsl.exe instead of directly. */
  wsl?: FairplayWsl;
}
