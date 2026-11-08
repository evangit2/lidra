import { describe, expect, it, vi } from "vitest";
import { TrackPipeline } from "../src/audio/pipeline";

/**
 * The player only learns the delivered quality once the first fragment is
 * decrypted. That transition has to reach the listener, or the badge can never
 * show a success.
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

describe("TrackPipeline state notifications", () => {
  it("notifies on every transition, including the first streamed fragment", () => {
    const onChange = vi.fn();
    const pipeline = makePipeline(onChange);

    (pipeline as unknown as { setState: (state: string) => void }).setState("streaming");
    (pipeline as unknown as { setState: (state: string) => void }).setState("complete");

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(pipeline.snapshot().state).toBe("complete");
  });

  it("keeps working when the listener throws", () => {
    const pipeline = makePipeline(() => {
      throw new Error("listener exploded");
    });

    expect(() =>
      (pipeline as unknown as { setState: (state: string) => void }).setState("streaming"),
    ).not.toThrow();
    expect(pipeline.snapshot().state).toBe("streaming");
  });
});
