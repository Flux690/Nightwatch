import { describe, expect, it } from "vitest";
import { computeDiffHunks } from "../sandbox/tools/diff.js";

describe("computeDiffHunks", () => {
  it("windows a single-line change with real line numbers on both sides", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "b", "c", "X", "e", "f", "g"].join("\n");

    const hunks = computeDiffHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { type: "unchanged", oldLineNumber: 1, newLineNumber: 1, content: "a" },
      { type: "unchanged", oldLineNumber: 2, newLineNumber: 2, content: "b" },
      { type: "unchanged", oldLineNumber: 3, newLineNumber: 3, content: "c" },
      { type: "removed", oldLineNumber: 4, newLineNumber: null, content: "d" },
      { type: "added", oldLineNumber: null, newLineNumber: 4, content: "X" },
      { type: "unchanged", oldLineNumber: 5, newLineNumber: 5, content: "e" },
      { type: "unchanged", oldLineNumber: 6, newLineNumber: 6, content: "f" },
      { type: "unchanged", oldLineNumber: 7, newLineNumber: 7, content: "g" },
    ]);
  });

  it("treats a brand-new file as entirely added, with no old-side line numbers", () => {
    const hunks = computeDiffHunks(null, "one\ntwo\nthree");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([
      { type: "added", oldLineNumber: null, newLineNumber: 1, content: "one" },
      { type: "added", oldLineNumber: null, newLineNumber: 2, content: "two" },
      {
        type: "added",
        oldLineNumber: null,
        newLineNumber: 3,
        content: "three",
      },
    ]);
  });

  it("windows a pure append at the end of a file", () => {
    const before = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
    const after = `${before}\nl11\nl12`;

    const hunks = computeDiffHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.map((l) => l.content)).toEqual([
      "l8",
      "l9",
      "l10",
      "l11",
      "l12",
    ]);
    expect(hunks[0].lines.map((l) => l.type)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
      "added",
      "added",
    ]);
  });

  it("windows a pure truncation at the end of a file", () => {
    const before = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n");
    const after = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");

    const hunks = computeDiffHunks(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.map((l) => l.content)).toEqual([
      "l8",
      "l9",
      "l10",
      "l11",
      "l12",
    ]);
    expect(hunks[0].lines.map((l) => l.type)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
      "removed",
      "removed",
    ]);
  });

  it("splits two far-apart changes into separate hunks, excluding the untouched middle", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const before = lines.join("\n");
    const after = lines
      .map((l, i) => (i === 4 ? "CHANGED5" : i === 14 ? "CHANGED15" : l))
      .join("\n");

    const hunks = computeDiffHunks(before, after);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].lines.map((l) => l.content)).toEqual([
      "line2",
      "line3",
      "line4",
      "line5",
      "CHANGED5",
      "line6",
      "line7",
      "line8",
    ]);
    expect(hunks[1].lines.map((l) => l.content)).toEqual([
      "line12",
      "line13",
      "line14",
      "line15",
      "CHANGED15",
      "line16",
      "line17",
      "line18",
    ]);

    const allContent = hunks.flatMap((h) => h.lines.map((l) => l.content));
    for (const excluded of [
      "line1",
      "line9",
      "line10",
      "line11",
      "line19",
      "line20",
    ]) {
      expect(allContent).not.toContain(excluded);
    }
  });

  it("returns no hunks when nothing changed", () => {
    const same = "a\nb\nc";
    expect(computeDiffHunks(same, same)).toEqual([]);
  });
});
