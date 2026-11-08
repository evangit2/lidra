/**
 * Session credential capture.
 *
 * The Apple Music web player authenticates every API and CDN request with two
 * values: a developer token (`Authorization: Bearer …`) and the subscriber's
 * media user token (`Media-User-Token: …`). Lidra reuses the signed-in web
 * session, so both values are observed from the traffic the page itself sends
 * rather than scraped from storage formats Apple changes without notice.
 */
import type { Session } from "electron";
import log from "electron-log/main";

const tokensLog = log.scope("audio.tokens");

export interface SessionCredentials {
  developerToken: string | null;
  mediaUserToken: string | null;
}

/** Both hosts serve the same API: `amp-api` is what the web client uses. */
const API_HOSTS = new Set(["api.music.apple.com", "amp-api.music.apple.com"]);

export function isAppleMusicApiRequest(url: string): boolean {
  try {
    return API_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  return null;
}

/**
 * Observes Apple Music API traffic and remembers the credentials it carries.
 * Tokens rotate, so the newest observed value always wins.
 */
export class CredentialStore {
  private developerToken: string | null = null;
  private mediaUserToken: string | null = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly session: Session) {
    session.webRequest.onBeforeSendHeaders(
      { urls: ["https://*.music.apple.com/*"] },
      (details, callback) => {
        if (!isAppleMusicApiRequest(details.url)) {
          callback({ requestHeaders: details.requestHeaders });
          return;
        }
        const authorization = headerValue(details.requestHeaders, "Authorization");
        if (authorization?.startsWith("Bearer ")) {
          this.setDeveloperToken(authorization.slice("Bearer ".length).trim());
        }
        const mediaUserToken = headerValue(details.requestHeaders, "Media-User-Token");
        if (mediaUserToken) this.setMediaUserToken(mediaUserToken);
        callback({ requestHeaders: details.requestHeaders });
      },
    );
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  setDeveloperToken(token: string): void {
    if (token.length === 0 || token === this.developerToken) return;
    this.developerToken = token;
    tokensLog.info("developer token captured");
    this.notify();
  }

  setMediaUserToken(token: string): void {
    if (token.length === 0 || token === this.mediaUserToken) return;
    this.mediaUserToken = token;
    tokensLog.info("media user token captured");
    this.notify();
  }

  /** Read the media user token from the session cookie jar as a fallback. */
  async refreshFromCookies(): Promise<void> {
    const cookies = await this.session.cookies.get({ name: "media-user-token" });
    const cookie = cookies.find((entry) => entry.value.length > 0);
    if (cookie) this.setMediaUserToken(cookie.value);
  }

  snapshot(): SessionCredentials {
    return {
      developerToken: this.developerToken,
      mediaUserToken: this.mediaUserToken,
    };
  }

  /** True when both credentials needed for a catalog lookup are present. */
  isReady(): boolean {
    return this.developerToken !== null && this.mediaUserToken !== null;
  }

  /** Resolve once both credentials are known, or after `timeoutMs`. */
  async waitForCredentials(timeoutMs = 15_000): Promise<SessionCredentials> {
    if (this.isReady()) return this.snapshot();
    await this.refreshFromCookies();
    if (this.isReady()) return this.snapshot();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== onReady);
        resolve(this.snapshot());
      }, timeoutMs);
      const onReady = (): void => {
        clearTimeout(timer);
        resolve(this.snapshot());
      };
      this.waiters.push(onReady);
    });
  }
}
