import { describe, expect, it } from "vitest";
import {
  classifyVariant,
  parseMasterPlaylist,
  parseMediaPlaylist,
  rankVariants,
  selectVariant,
} from "../src/audio/hls";

/**
 * The fixtures mirror the master playlist Apple returns for `enhancedHls`:
 * one `EXT-X-STREAM-INF` per rendition, with the quality descriptor packed into
 * the AUDIO attribute and the codec in CODECS.
 */
const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2",AUDIO="audio-stereo-256"
media-aac.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="alac",AUDIO="audio-alac-stereo-44100-16"
media-alac.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=9000000,CODECS="alac",AUDIO="audio-alac-stereo-192000-24"
media-hires.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=768000,CODECS="ec-3",AUDIO="audio-atmos-stereo-2768"
media-atmos.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=640000,CODECS="ac-3",AUDIO="audio-dolby-stereo-640"
media-dolby.m3u8
`;

describe("master playlists", () => {
  const variants = parseMasterPlaylist(MASTER, "https://aod.example.test/song/master.m3u8");

  it("resolves every rendition against the manifest URL", () => {
    expect(variants).toHaveLength(5);
    expect(variants[0].uri).toBe("https://aod.example.test/song/media-aac.m3u8");
  });

  it("classifies Apple quality descriptors", () => {
    const hires = variants.find((variant) => variant.codecs === "alac" && variant.sampleRate === 192000);
    expect(hires?.tier).toBe("hi-res");
    expect(hires?.bitDepth).toBe(24);
    expect(hires?.label).toBe("ALAC 24-bit/192 kHz");

    const cd = variants.find((variant) => variant.codecs === "alac" && variant.sampleRate === 44100);
    expect(cd?.tier).toBe("lossless");

    const atmos = variants.find((variant) => variant.codecs === "ec-3");
    expect(atmos?.tier).toBe("atmos");
    // Apple writes atmos bitrates with a leading 2.
    expect(atmos?.bitrateKbps).toBe(768);

    const dolby = variants.find((variant) => variant.codecs === "ac-3");
    expect(dolby?.tier).toBe("dolby-audio");
    expect(dolby?.bitrateKbps).toBe(640);
  });

  it("ranks hi-res above lossless above Dolby above AAC", () => {
    const ranked = rankVariants(variants);
    expect(ranked.map((variant) => variant.tier)).toEqual([
      "hi-res",
      "lossless",
      "atmos",
      "dolby-audio",
      "aac",
    ]);
  });

  it("selects the requested tier", () => {
    expect(selectVariant(variants, "lossless")?.tier).toBe("lossless");
    expect(selectVariant(variants, "atmos")?.tier).toBe("atmos");
  });

  it("falls back to the best available rendition", () => {
    const aacOnly = variants.filter((variant) => variant.tier === "aac");
    expect(selectVariant(aacOnly, "hi-res")?.tier).toBe("aac");
    expect(selectVariant([], "hi-res")).toBeNull();
    expect(selectVariant(variants, null)?.tier).toBe("hi-res");
  });

  it("de-duplicates renditions that repeat across variants", () => {
    const doubled = `${MASTER}\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="alac",AUDIO="audio-alac-stereo-44100-16"\nmedia-alac-again.m3u8\n`;
    expect(parseMasterPlaylist(doubled, "https://aod.example.test/m.m3u8")).toHaveLength(5);
  });

  it("keeps quoted attributes containing commas intact", () => {
    const classified = classifyVariant("alac", "audio-alac-stereo-96000-24", 4_000_000);
    expect(classified.tier).toBe("hi-res");
    expect(classified.sampleRate).toBe(96000);
  });
});

describe("media playlists", () => {
  const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:213
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://itunes.apple.com/P000000000/s1/e1",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-MAP:URI="media.m3u8",BYTERANGE="1200@0"
#EXTINF:213.000,
#EXT-X-BYTERANGE:52428800@1200
media.m3u8
#EXT-X-ENDLIST
`;

  it("parses keys, init sections and byte ranges", () => {
    const playlist = parseMediaPlaylist(MEDIA, "https://aod.example.test/song/media.m3u8");
    expect(playlist.targetDuration).toBe(213);
    expect(playlist.endList).toBe(true);
    expect(playlist.map).toEqual({
      uri: "https://aod.example.test/song/media.m3u8",
      byterange: { length: 1200, offset: 0 },
    });
    expect(playlist.segments).toHaveLength(1);
    expect(playlist.segments[0].byterange).toEqual({ length: 52428800, offset: 1200 });
    expect(playlist.segments[0].key?.uri).toBe(
      "skd://itunes.apple.com/P000000000/s1/e1",
    );
    expect(playlist.segments[0].key?.method).toBe("SAMPLE-AES");
  });

  it("inherits a key across segments and honours METHOD=NONE", () => {
    const text = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://a"
#EXTINF:2,
a.m4s
#EXTINF:2,
b.m4s
#EXT-X-KEY:METHOD=NONE
#EXTINF:2,
c.m4s
`;
    const playlist = parseMediaPlaylist(text, "https://host/x/playlist.m3u8");
    expect(playlist.segments.map((segment) => segment.key?.uri)).toEqual([
      "skd://a",
      "skd://a",
      undefined,
    ]);
  });

  it("continues byte ranges declared without an offset", () => {
    const text = `#EXTM3U
#EXTINF:2,
#EXT-X-BYTERANGE:100@0
file.m4s
#EXTINF:2,
#EXT-X-BYTERANGE:100
file.m4s
`;
    const playlist = parseMediaPlaylist(text, "https://host/x/p.m3u8");
    expect(playlist.segments[1].byterange).toEqual({ length: 100, offset: 100 });
  });

  it("rejects a malformed byte range", () => {
    const text = "#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:0@0\nfile.m4s\n";
    expect(() => parseMediaPlaylist(text, "https://host/p.m3u8")).toThrow(/BYTERANGE/);
  });
});
