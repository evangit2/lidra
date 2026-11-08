import { describe, expect, it } from "vitest";
import { makeBox, makeFullBox } from "../src/audio/mp4/box";
import {
  describeStream,
  inspectInitSegment,
  verifyAgainstVariant,
  QualityError,
} from "../src/audio/quality";
import type { AudioVariant } from "../src/audio/hls";

const u16 = (value: number) => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value, 0);
  return buffer;
};
const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
};

interface EntryOptions {
  format: string;
  channels: number;
  sampleSize: number;
  sampleRate: number;
  children?: Buffer[];
  version?: number;
  /** Wrap in `enca` + sinf/frma, the way Apple protects audio. */
  encrypted?: boolean;
}

/** Build an AudioSampleEntry as it appears inside stsd. */
function sampleEntry(options: EntryOptions): Buffer {
  const declared = options.sampleRate * 65536;
  const rate = declared > 0xffffffff ? 0 : declared;
  const header = Buffer.concat([
    Buffer.alloc(6, 0),
    u16(1),
    Buffer.alloc(8, 0),
    u16(options.channels),
    u16(options.sampleSize),
    u16(0),
    u16(0),
    u32(rate),
  ]);
  const children = [...(options.children ?? [])];
  if (options.encrypted) {
    const frma = makeBox("frma", Buffer.from(options.format, "latin1"));
    const schm = makeFullBox("schm", 0, 0, Buffer.concat([Buffer.from("cbcs", "latin1"), u32(0x10000)]));
    children.push(makeBox("sinf", Buffer.concat([frma, schm])));
  }
  const body = Buffer.concat([header, ...children]);
  return makeBox(options.encrypted ? "enca" : options.format, body);
}

function initSegment(entry: Buffer): Buffer {
  const stsd = makeFullBox("stsd", 0, 0, Buffer.concat([u32(1), entry]));
  const stbl = makeBox("stbl", stsd);
  const minf = makeBox("minf", Buffer.concat([makeFullBox("smhd", 0, 0, Buffer.alloc(4)), stbl]));
  const mdhd = makeFullBox("mdhd", 0, 0, Buffer.concat([u32(0), u32(0), u32(48000), u32(0), u16(0x55c4), u16(0)]));
  const hdlr = makeFullBox("hdlr", 0, 0, Buffer.concat([u32(0), Buffer.from("soun", "latin1"), Buffer.alloc(12), Buffer.from("SoundHandler\0")]));
  const mdia = makeBox("mdia", Buffer.concat([mdhd, hdlr, minf]));
  const tkhd = makeFullBox("tkhd", 0, 7, Buffer.alloc(80));
  const trak = makeBox("trak", Buffer.concat([tkhd, mdia]));
  const mvhd = makeFullBox("mvhd", 0, 0, Buffer.alloc(96));
  const mvex = makeBox("mvex", makeFullBox("trex", 0, 0, Buffer.concat([u32(1), u32(1), u32(0), u32(0), u32(0)])));
  const ftyp = makeBox("ftyp", Buffer.concat([Buffer.from("M4A ", "latin1"), u32(0), Buffer.from("M4A mp42isom", "latin1")]));
  return Buffer.concat([ftyp, makeBox("moov", Buffer.concat([mvhd, trak, mvex]))]);
}

/** ALAC magic cookie as Apple writes it. */
function alacCookie(bitDepth: number, channels: number, sampleRate: number, bitrate: number): Buffer {
  return makeBox(
    "alac",
    Buffer.concat([
      Buffer.alloc(4, 0), // full-box version/flags, as Apple writes it
      u32(4096), // frameLength
      Buffer.from([0]), // compatibleVersion
      Buffer.from([bitDepth]),
      Buffer.from([40]), // pb
      Buffer.from([10]), // mb
      Buffer.from([14]), // kb
      Buffer.from([channels]),
      u16(255), // maxRun
      u32(16384), // maxFrameBytes
      u32(bitrate),
      u32(sampleRate),
    ]),
  );
}

/** dec3: data_rate(13) num_ind_sub(3), then per substream 3 bytes. */
function dec3(dataRate: number, substreams: number, fscod: number, acmod: number, lfeon: number): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(((dataRate & 0x1fff) << 3) | ((substreams - 1) & 0x07), 0);
  const bits =
    ((fscod & 0x03) << 22) |
    ((16 & 0x1f) << 17) | // bsid 16
    ((0 & 0x01) << 16) |
    ((0 & 0x01) << 15) |
    ((0 & 0x07) << 12) |
    ((acmod & 0x07) << 9) |
    ((lfeon & 0x01) << 8);
  const body = Buffer.from([(bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff]);
  return makeBox("dec3", Buffer.concat([head, body]));
}

/** dac3: fscod(2) bsid(5) bsmod(3) acmod(3) lfeon(1) bit_rate_code(5). */
function dac3(fscod: number, acmod: number, lfeon: number, bitrateCode: number): Buffer {
  const bits =
    ((fscod & 0x03) << 22) |
    ((8 & 0x1f) << 17) |
    ((0 & 0x07) << 14) |
    ((acmod & 0x07) << 11) |
    ((lfeon & 0x01) << 10) |
    ((bitrateCode & 0x1f) << 5);
  return makeBox("dac3", Buffer.from([(bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff]));
}

/** esds carrying average bitrate plus an AAC AudioSpecificConfig. */
function esds(avgBitrate: number, sampleRateIndex: number, channelConfig: number): Buffer {
  const asc = Buffer.from([(2 << 3) | (sampleRateIndex >> 1), ((sampleRateIndex & 0x01) << 7) | (channelConfig << 3)]);
  const decoderSpecific = Buffer.concat([Buffer.from([0x05, asc.length]), asc]);
  const decoderConfig = Buffer.concat([
    Buffer.from([0x04, 13 + decoderSpecific.length]),
    Buffer.from([0x40, 0x15]), // AAC, audio stream
    Buffer.from([0, 0, 0]), // buffer size
    u32(avgBitrate),
    u32(avgBitrate),
    decoderSpecific,
  ]);
  const es = Buffer.concat([
    Buffer.from([0x03, 3 + decoderConfig.length]),
    u16(1),
    Buffer.from([0]),
    decoderConfig,
  ]);
  return makeFullBox("esds", 0, 0, es);
}

function variant(overrides: Partial<AudioVariant> = {}): AudioVariant {
  return {
    uri: "https://example.test/media.m3u8",
    codecs: "alac",
    audioGroup: "audio-alac-stereo-192000-24",
    bandwidth: 9216,
    tier: "hi-res",
    sampleRate: 192000,
    bitDepth: 24,
    label: "ALAC 24-bit/192 kHz",
    ...overrides,
  };
}

describe("inspectInitSegment", () => {
  it("reads a 24-bit/192 kHz ALAC cookie", () => {
    const init = initSegment(
      sampleEntry({
        format: "alac",
        channels: 2,
        sampleSize: 24,
        sampleRate: 192000,
        children: [alacCookie(24, 2, 192000, 9216000)],
      }),
    );
    const facts = inspectInitSegment(init);
    expect(facts.codec).toBe("alac");
    expect(facts.bitDepth).toBe(24);
    expect(facts.sampleRate).toBe(192000);
    expect(facts.channels).toBe(2);
    expect(facts.tier).toBe("hi-res");
    expect(facts.label).toBe("ALAC 24-bit/192 kHz stereo");
  });

  it("reads 16-bit/44.1 kHz lossless as lossless, not hi-res", () => {
    const init = initSegment(
      sampleEntry({
        format: "alac",
        channels: 2,
        sampleSize: 16,
        sampleRate: 44100,
        children: [alacCookie(16, 2, 44100, 1411200)],
      }),
    );
    const facts = inspectInitSegment(init);
    expect(facts.bitDepth).toBe(16);
    expect(facts.tier).toBe("lossless");
    expect(facts.label).toBe("ALAC 16-bit/44.1 kHz stereo");
  });

  it("treats 24-bit/44.1 kHz as lossless, matching Apple's ladder", () => {
    const init = initSegment(
      sampleEntry({
        format: "alac",
        channels: 2,
        sampleSize: 24,
        sampleRate: 44100,
        children: [alacCookie(24, 2, 44100, 2117000)],
      }),
    );
    const facts = inspectInitSegment(init);
    expect(facts.bitDepth).toBe(24);
    expect(facts.tier).toBe("lossless");
    expect(facts.label).toBe("ALAC 24-bit/44.1 kHz stereo");
  });

  it("falls back to the sample entry when the cookie is missing", () => {
    const init = initSegment(
      sampleEntry({ format: "alac", channels: 2, sampleSize: 24, sampleRate: 48000 }),
    );
    const facts = inspectInitSegment(init);
    expect(facts.bitDepth).toBe(24);
    expect(facts.sampleRate).toBe(48000);
    expect(facts.tier).toBe("lossless");
  });

  it("reads a 5.1 E-AC-3 Atmos bed", () => {
    const init = initSegment(
      sampleEntry({
        format: "ec-3",
        channels: 6,
        sampleSize: 16,
        sampleRate: 48000,
        children: [dec3(768, 1, 0, 7, 1)],
      }),
    );
    const facts = inspectInitSegment(init);
    expect(facts.codec).toBe("ec-3");
    expect(facts.channels).toBe(6);
    expect(facts.sampleRate).toBe(48000);
    expect(facts.bitrateKbps).toBe(768);
    expect(facts.atmos).toBe(true);
    expect(facts.tier).toBe("atmos");
    expect(facts.label).toBe("Dolby Digital Plus (Atmos) 48 kHz 6 channels 768 kbps");
  });

  it("does not call a stereo E-AC-3 stream an Atmos bed", () => {
    const init = initSegment(
      sampleEntry({
        format: "ec-3",
        channels: 2,
        sampleSize: 16,
        sampleRate: 48000,
        children: [dec3(192, 1, 0, 2, 0)],
      }),
    );
    const facts = inspectInitSegment(init);
    expect(facts.channels).toBe(2);
    expect(facts.atmos).toBe(false);
    expect(facts.label).toBe("Dolby Digital Plus 48 kHz stereo 192 kbps");
  });

  it("reads AC-3 bitrate from dac3", () => {
    const init = initSegment(
      sampleEntry({
        format: "ac-3",
        channels: 6,
        sampleSize: 16,
        sampleRate: 48000,
        children: [dac3(0, 7, 1, 14)],
      }),
    );
    const facts = inspectInitSegment(init);
    expect(facts.codec).toBe("ac-3");
    expect(facts.channels).toBe(6);
    expect(facts.bitrateKbps).toBe(384);
    expect(facts.tier).toBe("dolby-audio");
  });

  it("reads AAC rate, channels and bitrate from esds", () => {
    const init = initSegment(
      sampleEntry({
        format: "mp4a",
        channels: 2,
        sampleSize: 16,
        sampleRate: 44100,
        children: [esds(256000, 4, 2)],
      }),
    );
    const facts = inspectInitSegment(init);
    expect(facts.codec).toBe("aac");
    expect(facts.sampleRate).toBe(44100);
    expect(facts.channels).toBe(2);
    expect(facts.bitrateKbps).toBe(256);
    expect(facts.tier).toBe("aac");
    expect(facts.label).toBe("AAC 44.1 kHz stereo 256 kbps");
  });

  it("resolves an encrypted entry through sinf/frma like Apple's segments", () => {
    const init = initSegment(
      sampleEntry({
        format: "alac",
        channels: 2,
        sampleSize: 16,
        sampleRate: 44100,
        encrypted: true,
        children: [alacCookie(16, 2, 44100, 1411200)],
      }),
    );
    const facts = inspectInitSegment(init);
    expect(facts.codec).toBe("alac");
    expect(facts.bitDepth).toBe(16);
    expect(facts.label).toBe("ALAC 16-bit/44.1 kHz stereo");
    expect(facts.tier).toBe("lossless");
  });

  it("rejects input that is not an init segment", () => {
    expect(() => inspectInitSegment(Buffer.alloc(4))).toThrow(QualityError);
    expect(() => inspectInitSegment(initSegment(Buffer.alloc(0)))).toThrow(/stsd|sample entries|truncated/);
  });
});

describe("verifyAgainstVariant", () => {
  const hiResInit = initSegment(
    sampleEntry({
      format: "alac",
      channels: 2,
      sampleSize: 24,
      sampleRate: 192000,
      children: [alacCookie(24, 2, 192000, 9216000)],
    }),
  );
  void hiResInit;

  it("passes when the stream matches the manifest", () => {
    const check = verifyAgainstVariant(variant(), inspectInitSegment(hiResInit));
    expect(check.ok).toBe(true);
    expect(check.mismatches).toEqual([]);
  });

  it("catches a manifest that promised hi-res but delivered 16/44.1", () => {
    const cdInit = initSegment(
      sampleEntry({
        format: "alac",
        channels: 2,
        sampleSize: 16,
        sampleRate: 44100,
        children: [alacCookie(16, 2, 44100, 1411200)],
      }),
    );
    const check = verifyAgainstVariant(variant(), inspectInitSegment(cdInit));
    expect(check.ok).toBe(false);
    expect(check.mismatches.join(" ")).toMatch(/requested hi-res but the stream is lossless/);
    expect(check.mismatches.join(" ")).toMatch(/192000 Hz but the stream is 44100 Hz/);
    expect(check.mismatches.join(" ")).toMatch(/24-bit but the stream is 16-bit/);
  });

  it("catches a bitrate that is not what was advertised", () => {
    const check = verifyAgainstVariant(
      variant({ tier: "aac", codecs: "mp4a.40.2", bitrateKbps: 256, sampleRate: 44100, bitDepth: undefined }),
      inspectInitSegment(
        initSegment(
          sampleEntry({
            format: "mp4a",
            channels: 2,
            sampleSize: 16,
            sampleRate: 44100,
            children: [esds(64000, 4, 2)],
          }),
        ),
      ),
    );
    expect(check.ok).toBe(false);
    expect(check.mismatches.join(" ")).toMatch(/256 kbps but the stream is 64 kbps/);
  });
});

describe("describeStream", () => {
  it("labels multichannel PCM-style streams clearly", () => {
    expect(
      describeStream({
        codec: "flac",
        sampleRate: 48000,
        bitDepth: 24,
        channels: 6,
        bitrateKbps: null,
        atmos: false,
        label: "",
        tier: "lossless",
      }),
    ).toBe("FLAC 24-bit/48 kHz 6 channels");
  });
});
