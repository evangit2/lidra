import { describe, expect, it, vi } from "vitest";
import { CredentialStore, isAppleMusicApiRequest } from "../src/audio/tokens";

function fakeSession(): Electron.Session {
  return {
    webRequest: { onBeforeSendHeaders: vi.fn() },
    cookies: { get: vi.fn(async () => []) },
  } as unknown as Electron.Session;
}

describe("isAppleMusicApiRequest", () => {
  it("accepts the regional amp-api hosts the web player uses", () => {
    expect(isAppleMusicApiRequest("https://amp-api-edge.music.apple.com/v1/catalog/us/songs/1")).toBe(
      true,
    );
    expect(isAppleMusicApiRequest("https://amp-api-edge-2.music.apple.com/v1/me")).toBe(true);
  });

  it("keeps accepting the classic API hosts", () => {
    expect(isAppleMusicApiRequest("https://amp-api.music.apple.com/v1/me")).toBe(true);
    expect(isAppleMusicApiRequest("https://api.music.apple.com/v1/me")).toBe(true);
  });

  it("ignores page and third-party hosts", () => {
    expect(isAppleMusicApiRequest("https://music.apple.com/us/album/so-what/268443092")).toBe(false);
    expect(isAppleMusicApiRequest("https://amp-api.music.apple.com.example.test/v1/me")).toBe(false);
    expect(isAppleMusicApiRequest("not a url")).toBe(false);
  });
});

describe("CredentialStore page token fallback", () => {
  it("takes the developer token from the page when no request was observed", async () => {
    const store = new CredentialStore(fakeSession());
    store.setMediaUserToken("media-user");
    store.setPageTokenSource(async () => "t".repeat(120));

    const snapshot = await store.waitForCredentials(50);

    expect(snapshot.developerToken).toBe("t".repeat(120));
    expect(snapshot.mediaUserToken).toBe("media-user");
    expect(store.isReady()).toBe(true);
  });

  it("ignores a page value that is not a token", async () => {
    const store = new CredentialStore(fakeSession());
    store.setMediaUserToken("media-user");
    store.setPageTokenSource(async () => "short");

    const snapshot = await store.waitForCredentials(30);

    expect(snapshot.developerToken).toBeNull();
  });

  it("survives a page that throws", async () => {
    const store = new CredentialStore(fakeSession());
    store.setPageTokenSource(async () => {
      throw new Error("no window");
    });

    const snapshot = await store.waitForCredentials(30);

    expect(snapshot.developerToken).toBeNull();
  });
});
