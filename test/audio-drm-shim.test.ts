import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");

describe("the EME shim that ships to the page", () => {
  const source = readFileSync(join(root, "assets", "lidraDrm.js"), "utf-8");

  it("only mentions its enable flag as a placeholder", () => {
    expect(source).toContain("__LIDRA_EME__");
    expect(source).not.toContain("__LIDRA_EME__ =");
  });

  it("substitutes every mention, not just the comment", () => {
    // The flag is named in the file's own doc comment, so a single `replace`
    // rewrote the comment and left the guard as a ReferenceError — the shim
    // never installed and the page fell back to previews.
    const prepared = source.replaceAll("__LIDRA_EME__", "true");
    expect(prepared).not.toContain("__LIDRA_EME__");
    expect(prepared).toContain("if (!true) return;");
  });

  it("is wired up with replaceAll in the main process", () => {
    const main = readFileSync(join(root, "src", "main.ts"), "utf-8");
    expect(main).toContain('replaceAll("__LIDRA_EME__", "true")');
    expect(main.includes('replace("__LIDRA_EME__", "true")')).toBe(false);
  });
});
