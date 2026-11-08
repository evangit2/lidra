import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { sampleLayout } from "../src/audio/legacy/segment";
import { LegacyDecryptor } from "../src/audio/legacy/decryptor";

const PORT = Number(process.env.WRAPPER_PORT ?? 10030);

function spansOf(seg: Buffer) {
  const layout = sampleLayout(seg, 0);
  const runs: Buffer[] = [];
  for (const sample of layout.samples) {
    if (sample.subsamples?.length) {
      for (const entry of sample.subsamples) {
        if (entry.protected) runs.push(seg.subarray(sample.offset, sample.offset + sample.size));
      }
    } else {
      runs.push(seg.subarray(sample.offset, sample.offset + sample.size));
    }
  }
  return { layout, runs };
}

describe("batch after key switch", () => {
  it("decrypts segment 1 then segment 2 in batches", async () => {
    const seg1 = readFileSync("/tmp/hq/seg1.m4s");
    const seg2 = readFileSync("/tmp/hq/seg2.m4s");
    const decryptor = new LegacyDecryptor(`127.0.0.1:${PORT}`, 60_000);

    const runFragment = async (seg: Buffer, request: any, label: string) => {
      const { layout, runs } = spansOf(seg);
      const started = Date.now();
      try {
        const plains = await decryptor.decryptBatch(runs, request);
        const head = plains[0].subarray(0, 4).toString("hex");
        console.log(`${label} runs=${runs.length} time=${Date.now() - started}ms head=${head} samples=${layout.samples.length}`);
        return plains;
      } catch (error: any) {
        console.log(`${label} FAILED after ${Date.now() - started}ms: ${error?.message}`);
        return null;
      }
    };

    await decryptor.armFragment({ adamId: "0", keyUri: "skd://itunes.apple.com/P000000000/s1/e1", perSampleIvSize: 0 });
    await runFragment(seg1, { adamId: "0", keyUri: "skd://itunes.apple.com/P000000000/s1/e1", perSampleIvSize: 0 }, "seg1");
    await decryptor.armFragment({ adamId: "268443097", keyUri: "skd://itunes.apple.com/p1305215351/c6", perSampleIvSize: 0 });
    await runFragment(seg2, { adamId: "268443097", keyUri: "skd://itunes.apple.com/p1305215351/c6", perSampleIvSize: 0 }, "seg2");
    decryptor.close();
  }, 600_000);
});
