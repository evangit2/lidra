import { describe, expect, it, vi } from "vitest";
import { TrackPipeline } from "../src/audio/pipeline";

/**
 * The player only learns the delivered quality once the first fragment is
 * decrypted. Transitions have to reach the listener, or the badge can never
 * show a success. The streaming/complete transitions need ffmpeg and the
 * backend, so these units drive the network-free error transition through
 * the private fail(); the emit() path is shared by every transition.
 */
function makePipeline(onChange: () => void): TrackPipeline {
  return new TrackPipeline({
    asset: {
      id: "268443097",
      name: "So What",
      artistName: "Miles Davis",
      manifestUrl: "https://example.test/master.m3u8",
      artworkUrl: null,
    } as never,
    preference: null,
    keyCache: {} as never,
    cacheRoot: "/tmp/lidra-pipeline-test",
    onChange,
  } as never);
}

type Failable = { fail: (error: unknown) => void };

describe("TrackPipeline state notifications", () => {
  it("notifies on a transition, including from the initial state", () => {
    const onChange = vi.fn();
    const pipeline = makePipeline(onChange);
    expect(pipeline.snapshot().state).toBe("preparing");

    (pipeline as unknown as Failable).fail(new Error("boom"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(pipeline.snapshot().state).toBe("error");
  });

  it("keeps working when the listener throws", () => {
    const pipeline = makePipeline(() => {
      throw new Error("listener exploded");
    });

    expect(() => (pipeline as unknown as Failable).fail(new Error("boom"))).not.toThrow();
    expect(pipeline.snapshot().state).toBe("error");
  });
});
