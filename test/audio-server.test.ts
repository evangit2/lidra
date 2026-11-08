import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HlsServer, type TrackLocation } from "../src/audio/server";

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-MAP:URI="init.mp4",BYTERANGE="800@0"
#EXTINF:2.0,
seg0.m4s
`;

describe("loopback HLS server", () => {
  let root: string;
  let server: HlsServer;
  let location: TrackLocation | null;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lidra-hls-"));
    fs.writeFileSync(path.join(root, "playlist.m3u8"), PLAYLIST);
    fs.writeFileSync(path.join(root, "init.mp4"), Buffer.alloc(800, 1));
    fs.writeFileSync(path.join(root, "seg0.m4s"), Buffer.from("segment-bytes"));
    location = {
      directory: root,
      codecs: "flac",
      bandwidth: 900_000,
      complete: false,
    };
    server = new HlsServer({ resolveTrack: () => location });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves a master playlist that advertises the muxed codec", async () => {
    const response = await fetch(server.masterUrl("track1"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('CODECS="flac"');
    expect(body).toContain("media.m3u8");
  });

  it("serves the media playlist and segments", async () => {
    const base = server.masterUrl("track1").replace("master.m3u8", "");
    const playlist = await (await fetch(`${base}media.m3u8`)).text();
    expect(playlist).toContain("seg0.m4s");

    const segment = await fetch(`${base}seg0.m4s`);
    expect(segment.status).toBe(200);
    expect(await segment.text()).toBe("segment-bytes");
    expect(segment.headers.get("content-type")).toBe("video/mp4");
  });

  it("answers byte-range requests", async () => {
    const base = server.masterUrl("track1").replace("master.m3u8", "");
    const response = await fetch(`${base}init.mp4`, { headers: { Range: "bytes=0-15" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-15/800");
    expect((await response.arrayBuffer()).byteLength).toBe(16);
  });

  it("permits the page's origin and answers preflight", async () => {
    const base = server.masterUrl("track1").replace("master.m3u8", "");
    const preflight = await fetch(`${base}seg0.m4s`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://music.apple.com",
        "Access-Control-Request-Headers": "range",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://music.apple.com",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Range");

    const get = await fetch(`${base}seg0.m4s`, {
      headers: { Origin: "https://music.apple.com" },
    });
    expect(get.headers.get("access-control-allow-origin")).toBe("https://music.apple.com");
  });

  it("asks the player to retry while a track is unknown", async () => {
    location = null;
    const response = await fetch(server.masterUrl("track1"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  it("rejects requests without the run token", async () => {
    const port = server.origin.split(":").pop();
    const response = await fetch(`http://127.0.0.1:${port}/wrong/track1/master.m3u8`);
    expect(response.status).toBe(404);
  });
});
