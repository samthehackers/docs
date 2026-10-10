/**
 * Test stand-in for lib/fal/signaling.ts's connectLucy: a LOCAL WebRTC loopback (two peers in one page, the second one
 * receiving the synthetic camera) instead of fal. Used by the browser harnesses in tests/public; never by the app.
 */
import type { ConnectOptions, LucyConnection } from "@/lib/fal/signaling";

export function connectLucy(o: ConnectOptions): LucyConnection {
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
