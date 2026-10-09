/**
 * Browser bundle for tests/public/diagnostics.spec.ts (built with esbuild at test time; not a test file itself).
 *
 * Runs the real realtime check (lib/diagnostics/run.ts, with the real synthetic camera) against a LOCAL WebRTC loopback
 * instead of fal: two RTCPeerConnections in the same page, one sending the synthetic camera, one receiving it. This
 * checks that the measuring code works with real Chromium objects (captureStream, requestVideoFrameCallback, getStats).
 * It says nothing about fal: the "transformed" video here is just the test pattern coming back.
 */
import type { ConnectOptions, LucyConnection } from "@/lib/fal/signaling";
import { runDiagnostics } from "@/lib/diagnostics/run";
import { startSyntheticCamera } from "@/lib/diagnostics/synthetic-camera";

function loopbackConnect(o: ConnectOptions): LucyConnection {
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => { if (e.candidate) void b.addIceCandidate(e.candidate); };
  b.onicecandidate = (e) => { if (e.candidate) void a.addIceCandidate(e.candidate); };
  b.ontrack = (e) => { o.onTrace?.("remote_track"); o.onRemoteStream(e.streams[0] ?? new MediaStream([e.track])); };
  b.onconnectionstatechange = () => { if (b.connectionState === "connected") o.onState("live"); };
  o.stream.getTracks().forEach((t) => a.addTrack(t, o.stream));
  o.onState("connecting");
  void (async () => {
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    o.onTrace?.("offer_sent");
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    o.onTrace?.("answer_applied");
  })().catch((e) => o.onState("failed", String(e), { code: "setup_error", message: String(e) }));
  return { pc: () => b, close: () => { a.close(); b.close(); o.onState("closed"); } };
}

async function runLoopback() {
  const canvas = document.getElementById("c") as HTMLCanvasElement;
  const output = document.getElementById("v") as HTMLVideoElement;
  const calls: { url: string; body: unknown }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const body = url.endsWith("/end") ? { ended: true } : { sessionId: "loopback-session" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const report = await runDiagnostics({ fetch, connect: loopbackConnect, camera: () => startSyntheticCamera(canvas), output, endpoint: location.origin, app: "local loopback (no fal)", prompt: "loopback" });
  return { report, calls };
}

(window as unknown as { __diagnosticsHarness: unknown }).__diagnosticsHarness = { runLoopback };
