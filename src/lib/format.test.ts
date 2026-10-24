import { describe, expect, it } from "vitest";
import { age, bytes, recBit, recKinds, shortPath } from "./format";

describe("format", () => {
  it("uses binary units like Explorer", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(4.2 * 1024 ** 3)).toBe("4.2 GB");
    expect(bytes(500 * 1024 ** 3)).toBe("500 GB");
  });
  it("describes ages", () => {
    const now = 1_000_000_000;
    expect(age(now - 3 * 86400, now)).toBe("3 days");
    expect(age(now - 548 * 86400, now)).toBe("18 months");
    expect(age(now - 731 * 86400, now)).toBe("2 years");
    expect(age(0, now)).toBe("unknown");
  });
  it("maps recommendation bits in Rust order", () => {
    expect(recBit("largeOld")).toBe(1);
    expect(recBit("duplicate")).toBe(32);
    expect(recKinds(1 | 32)).toEqual(["largeOld", "duplicate"]);
  });
  it("shortens paths in the middle", () => {
    const p = String.raw`C:\Users\Alex\Documents\Projects\2024\Client\Deliverables\final\export.mp4`;
    const s = shortPath(p, 40);
    expect(s.length).toBeLessThanOrEqual(44);
    expect(s.endsWith("export.mp4")).toBe(true);
    expect(s).toContain("…");
  });
});
