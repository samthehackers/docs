import Link from "next/link";
import { Card } from "@/components/ui/card";
import { DiagnosticsPanel } from "@/components/admin/diagnostics-panel";
import { diagnosticsOverview } from "@/lib/admin-diagnostics";
import { FIRST_FRAME_WAIT_MS, PASS_CRITERIA } from "@/lib/diagnostics/criteria";
import { requireAdminPage } from "@/lib/session-user";
import { relativeTime } from "@/lib/utils";

export const metadata = { title: "Realtime diagnostics" };
export const dynamic = "force-dynamic";

type RunMeta = { pass?: boolean; failureCode?: string | null; timeToFirstFrameMs?: number | null; fps?: number | null; rttMs?: number | null };

export default async function Diagnostics() {
  // Same rule as /admin: the layout is not a boundary, so the page checks the role first, and so does its data function.
  await requireAdminPage();
  const o = await diagnosticsOverview();
  return (
    <div className="space-y-6">
      <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Admin</Link>
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Realtime diagnostics</h1>
        <p className="text-sm text-muted-foreground">
          Runs one real connection to <code>{o.app}</code> from this browser, with an animated test pattern instead of a camera, using the Studio&apos;s own
          connection code: an unbilled diagnostics session, a token through <code>/api/fal/proxy</code>, offer, answer and ICE. It then samples the video for{" "}
          {PASS_CRITERIA.sampleMs / 1000} s and closes everything. No user credits are used; fal bills its own usage for the seconds the check runs.
        </p>
        <p className="text-sm text-muted-foreground">
          <b>PASS</b> = no failure or interruption, the first frame within {PASS_CRITERIA.firstFrameMaxMs / 1000} s of starting the connection, at least{" "}
          {PASS_CRITERIA.minFps} decoded fps on average over a {PASS_CRITERIA.sampleMs / 1000} s sample and at least {PASS_CRITERIA.minIntervalFps} fps in every second of it.
          The check cannot tell a transformed frame from any other: look at the received video. The check gives up after {FIRST_FRAME_WAIT_MS / 1000} s without a frame.
          Record results in <code>docs/REALTIME_VERIFICATION.md</code>.
        </p>
      </div>
      <DiagnosticsPanel app={o.app} configured={o.configured} />
      <section className="space-y-2">
        <h2 className="font-semibold">Recent checks</h2>
        {o.recent.length === 0 ? <Card className="text-sm text-muted-foreground">No check has been recorded yet.</Card> : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground"><tr><th className="p-3">When</th><th className="p-3">Admin</th><th className="p-3">Result</th><th className="p-3">First frame</th><th className="p-3">FPS</th><th className="p-3">RTT</th><th className="p-3">Failure</th></tr></thead>
              <tbody className="divide-y">{o.recent.map((a) => {
                const m = (a.meta ?? {}) as RunMeta;
                return <tr key={a.id}><td className="p-3">{relativeTime(a.createdAt)}</td><td className="p-3 text-xs">{a.actorId}</td><td className="p-3">{m.pass === undefined ? "—" : m.pass ? "PASS" : "FAIL"}</td><td className="p-3">{m.timeToFirstFrameMs ?? "—"}{typeof m.timeToFirstFrameMs === "number" ? " ms" : ""}</td><td className="p-3">{m.fps ?? "—"}</td><td className="p-3">{m.rttMs ?? "—"}{typeof m.rttMs === "number" ? " ms" : ""}</td><td className="p-3 text-xs">{m.failureCode ?? "—"}</td></tr>;
              })}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
