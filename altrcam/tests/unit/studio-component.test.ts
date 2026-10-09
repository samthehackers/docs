/**
 * A smoke test of the Studio component's first render (server-side render, before any effect runs), because there is
 * no DOM library here to mount it. It proves the component builds and renders with the new controllers wired in, shows
 * the two standing notes, and starts with "Go live" disabled until a camera is ready.
 *
 * What this does NOT prove: anything that happens after mount (effects, camera prompts, clicks). Those behaviours live
 * in lib/studio-session.ts and lib/studio-camera.ts and are tested there; the wiring between them and the buttons
 * has not been exercised in a browser.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Studio } from "@/components/studio/studio";
import { STUDIO_NOTICES } from "@/lib/studio-messages";

const html = renderToStaticMarkup(createElement(Studio, {
  resolution: "low", clipRecording: false, balance: 300, presets: [],
  initial: { prompt: "an astronaut", enablePromptExpansion: true, kind: "prompt", referencePath: null },
}));
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("Studio first render", () => {
  it("shows the video-only note and the not-verified notice, worded in lib/studio-messages.ts", () => {
    expect(decode(html)).toContain(STUDIO_NOTICES.videoOnly);
    expect(decode(html)).toContain(STUDIO_NOTICES.unverified);
  });

  it("starts ready, with the credit balance, and Go live disabled until the camera is open", () => {
    expect(html).toContain("Ready");
    expect(html).toContain("300");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Go live/s);
  });

  it("shows no error, no Retry camera and no Reconnect before anything has gone wrong", () => {
    expect(html).not.toContain("Retry camera");
    expect(html).not.toContain("Reconnect");
    expect(html).not.toContain('role="alert"');
  });

  it("has the camera picker, prompt and the preview and output areas", () => {
    expect(html).toContain('id="cam"');
    expect(html).toContain("No camera available");
    expect(html).toContain('id="prompt"');
    expect(html).toContain("Your camera preview");
    expect(html).toContain("AI transformed output");
  });
});
