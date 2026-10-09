/**
 * The Studio's wording (lib/studio-messages.ts): every failure maps to a distinct plain-language message, no technical
 * text or holes leak into the headline, and the two standing notes say what they must.
 */
import { describe, expect, it } from "vitest";
import { describeFailure, describeStartFailure, MESSAGES, STUDIO_NOTICES } from "@/lib/studio-messages";
import type { FailureCode, LucyFailure } from "@/lib/fal/signaling";

const CODES: FailureCode[] = ["token_refused", "token_unreachable", "socket_error", "model_error", "bad_answer", "answer_timeout", "ice_failed", "connection_lost", "setup_error"];

describe("connection failures", () => {
  it("every failure code has its own message, in whole sentences, with no placeholders showing", () => {
    const texts = CODES.map((code) => describeFailure({ code, message: "Model error" }));
    expect(new Set(texts).size).toBe(CODES.length);
    for (const t of texts) { expect(t).toMatch(/[.]$/); expect(t).not.toMatch(/undefined|null|\[object/); }
  });

  it("a refused token says what the status means", () => {
    const f = (status: number): LucyFailure => ({ code: "token_refused", message: "x", status });
    expect(describeFailure(f(401))).toMatch(/signed out/);
    expect(describeFailure(f(403))).toMatch(/no longer open/);
    expect(describeFailure(f(429))).toMatch(/Too many/);
    expect(describeFailure(f(400))).toMatch(/HTTP 400/);
    expect(describeFailure({ code: "token_refused", message: "x" })).not.toMatch(/HTTP|undefined/);
  });

  it("passes the service's own error text through, but not the generic placeholder", () => {
    expect(describeFailure({ code: "model_error", message: "quota exceeded" })).toBe("The AI service reported an error: quota exceeded.");
    expect(describeFailure({ code: "model_error", message: "Out of capacity!" })).toBe("The AI service reported an error: Out of capacity!");
    expect(describeFailure({ code: "model_error", message: "Model error" })).toBe("The AI service reported an error.");
    expect(describeFailure({ code: "model_error", message: "  " })).toBe("The AI service reported an error.");
  });
});

describe("start failures", () => {
  it("network failure: retryable", () => {
    expect(describeStartFailure({ network: true })).toMatchObject({ retry: true, outOfCredits: false });
  });
  it("402 means out of credits and is not retryable", () => {
    expect(describeStartFailure({ status: 402 })).toEqual({ message: MESSAGES.outOfCredits, retry: false, outOfCredits: true });
  });
  it("503 uses the server's own honest message when it has one", () => {
    expect(describeStartFailure({ status: 503, error: "Live transformation isn't available yet. The service is not configured." }).message).toMatch(/isn't available yet/);
    expect(describeStartFailure({ status: 503 }).message).toMatch(/isn't available right now/);
  });
  it("429, 5xx, 401 and 403 are told apart", () => {
    const m = [429, 500, 401, 403].map((status) => describeStartFailure({ status }).message);
    expect(new Set(m).size).toBe(4);
    expect(describeStartFailure({ status: 429 }).retry).toBe(true);
    expect(describeStartFailure({ status: 401 }).retry).toBe(false);
    expect(describeStartFailure({ status: 403, error: "Account not found" })).toMatchObject({ message: "Account not found", retry: false });
  });
  it("an unknown status still says something with the status in it", () => {
    expect(describeStartFailure({ status: 418 }).message).toMatch(/418/);
  });
});

describe("the standing notes", () => {
  it("say plainly that only video is transformed and no audio is captured or sent", () => {
    expect(STUDIO_NOTICES.videoOnly).toMatch(/video only/i);
    expect(STUDIO_NOTICES.videoOnly).toMatch(/microphone/i);
    expect(STUDIO_NOTICES.videoOnly).toMatch(/no audio is captured or sent/i);
  });
  it("say honestly that live transformation hasn't been tested against the real service, and that failed attempts use credits", () => {
    expect(STUDIO_NOTICES.unverified).toMatch(/hasn't been tested against the real/i);
    expect(STUDIO_NOTICES.unverified).toMatch(/Credits are used while a session is open, even if it never connects/);
  });
  it("don't claim it works", () => {
    for (const t of Object.values(STUDIO_NOTICES)) expect(t).not.toMatch(/\b(works|verified and|guaranteed|fully|always)\b/i);
  });
});
