/**
 * Browser bundle for tests/public/diagnostics.spec.ts: the REAL DiagnosticsPanel component, rendered on its own. The
 * spec bundles it with lib/fal/signaling.ts replaced by ./loopback-signaling.ts, so "Run check" connects to a local
 * loopback instead of fal, and serves it as /admin/diagnostics for the real scripts/smoke-realtime.ts to drive.
 */
import { createRoot } from "react-dom/client";
import { DiagnosticsPanel } from "@/components/admin/diagnostics-panel";

createRoot(document.getElementById("root")!).render(<DiagnosticsPanel app="local loopback (no fal)" configured />);
