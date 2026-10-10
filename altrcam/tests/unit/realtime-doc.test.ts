/**
 * docs/REALTIME_VERIFICATION.md says what the code does: the PASS numbers match PASS_CRITERIA, the docs that send people
 * there link to it, and its status line agrees with its results table (no rows = "Not yet run against production").
 * Recording a real run (adding a row) does not break this; rewording the status to match does.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FIRST_FRAME_WAIT_MS, PASS_CRITERIA } from "@/lib/diagnostics/criteria";

const read = (f: string) => readFileSync(path.resolve(__dirname, "../..", f), "utf8");
const doc = read("docs/REALTIME_VERIFICATION.md");

describe("docs/REALTIME_VERIFICATION.md", () => {
  it("states the PASS numbers the code applies", () => {
    expect(doc).toContain(`at most **${PASS_CRITERIA.firstFrameMaxMs / 1000} s**`);
    expect(doc).toContain(`at least **${PASS_CRITERIA.minFps} fps**`);
    expect(doc).toContain(`**${PASS_CRITERIA.sampleMs / 1000} s** of sampling`);
    expect(doc).toContain(`at least **${PASS_CRITERIA.minIntervalFps} fps** in **every** interval`);
    expect(doc).toContain("connection_interrupted");
    expect(doc).toContain(`up to ${FIRST_FRAME_WAIT_MS / 1000} s`);
  });

  it("has the results table, and says it has not been run while the table is empty", () => {
    const header = "| Date (UTC) | Endpoint | TTFF | FPS | RTT | Pass/fail |";
    expect(doc).toContain(header);
    const after = doc.slice(doc.indexOf(header)).split("\n").slice(2);
    const rows = after.slice(0, after.findIndex((l) => !l.startsWith("|")));
    if (rows.length === 0) {
      expect(doc).toContain("**Status: Not yet run against production.**");
      expect(doc).toContain("_Not yet run against production._");
    }
    expect(doc).toContain('The "Live video isn\'t confirmed yet" notices stay up until a passing run is recorded in this table.');
  });

  it("is linked from GO_LIVE.md section 7 and README_LIMITATIONS.md", () => {
    const goLive = read("GO_LIVE.md");
    const s7 = goLive.slice(goLive.indexOf("## 7."), goLive.indexOf("## 8."));
    expect(s7).toContain("(docs/REALTIME_VERIFICATION.md)");
    expect(read("README_LIMITATIONS.md")).toContain("(docs/REALTIME_VERIFICATION.md)");
  });
});
