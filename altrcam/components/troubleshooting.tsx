/**
 * Self-service answers on /support. Written from how the app is built (the Studio, metering and billing code, the FAQ and
 * the Terms), not from live sessions: the app has not been run end to end against the real AI service or payment providers
 * (README_LIMITATIONS.md). So this promises no response times and no outcomes, and says plainly where the cause
 * might be on our side. Limits that can change (session length, allowances) are read from the effective plan config.
 */
import Link from "next/link";
import { fmtSessionLimit } from "@/lib/account-summary";
import { HEARTBEAT_SECONDS, STALE_AFTER_SECONDS, type Plan, type PlanConfig } from "@/lib/plans";
import { fmtNum } from "@/lib/utils";

export interface TroubleshootingItem { id: string; title: string; body: React.ReactNode }

const Ul = ({ children }: { children: React.ReactNode }) => <ul className="mt-2 list-disc space-y-1.5 pl-5">{children}</ul>;
const A = ({ href, children }: { href: string; children: React.ReactNode }) => <Link href={href} className="text-primary underline">{children}</Link>;

export function troubleshootingItems(plans: Record<Plan, PlanConfig>): TroubleshootingItem[] {
  return [
    {
      id: "camera",
      title: "My camera is blocked, missing or won't start",
      body: (
        <>
          <p>If the Studio says camera access was blocked, your browser has the camera turned off for AltrCam. If it says it couldn&apos;t open a camera, the browser could not start one: none was found, another app was using it, or the page is not secure.</p>
          <Ul>
            <li><b>Allow the camera.</b> Click the camera or padlock icon next to the address bar, set Camera to Allow for this site, then reload the Studio. In Safari, use Safari menu, Settings for This Website, Camera.</li>
            <li><b>Close other apps that use the camera.</b> Video-call apps, recording or streaming software and other browser tabs can hold the camera, and many cameras work with only one app at a time.</li>
            <li><b>Check your computer&apos;s privacy settings.</b> Windows: Settings, Privacy &amp; security, Camera. macOS: System Settings, Privacy &amp; Security, Camera. Make sure your browser is allowed to use it.</li>
            <li><b>Use the https:// address.</b> Browsers only offer the camera on secure pages, so a page whose address starts with http:// cannot start it.</li>
            <li><b>Wrong camera, or none listed?</b> Plug it in, reload the Studio and pick it in the Camera menu. The menu is locked while you are live, so press Stop first.</li>
            <li>If nothing helps, restart the browser or try another one.</li>
          </Ul>
          <p className="mt-2">AltrCam only uses the camera. It never asks for your microphone.</p>
        </>
      ),
    },
    {
      id: "connection",
      title: "I can't connect, or the video is frozen or black",
      body: (
        <>
          <p>The preview marked &ldquo;You&rdquo; is your own camera. If that one is black, see the camera answer above. If only the AltrCam side stays empty or freezes, the problem is the connection to the AI service.</p>
          <p className="mt-2">What the status badge means:</p>
          <Ul>
            <li><b>Ready:</b> your camera is open and nothing is being sent yet.</li>
            <li><b>Connecting:</b> a session has started and the Studio is waiting for the AI service to answer. It also shows if a live connection is interrupted while the browser tries to recover it.</li>
            <li><b>Live:</b> the transformed video is coming back.</li>
            <li><b>Failed or Closed:</b> the connection could not be made, broke, or was shut down. When the Studio has a reason it appears next to the badge, so quote it in a ticket.</li>
          </Ul>
          <p className="mt-2">Things to try, in order:</p>
          <Ul>
            <li>Press Reconnect (or Stop, then Go live again). This starts a fresh session, billed from its own start, and a new session closes any earlier one. Each attempt is billed for the time it was open, so if it fails the same way twice, fix the cause before trying again.</li>
            <li>Check that your internet is steady in both directions. Moving closer to the router or using a cable helps.</li>
            <li>Turn off any VPN, or try another network such as a phone hotspot. Some VPNs, proxies and work or school firewalls block the kind of real-time connection (WebRTC) that video needs.</li>
            <li>While you are live, the Studio shows FPS, round-trip time, jitter and packet loss. High round-trip time or packet loss points to the network.</li>
            <li>Apply changes restarts the connection so a new prompt or reference image takes effect, so a short interruption after pressing it is expected.</li>
          </Ul>
          <p className="mt-2">If the Studio says live transformation isn&apos;t available because the service is not configured, the live service is not switched on for this deployment and there is nothing to fix on your side.</p>
          <p className="mt-2">If it still fails on a good connection with no VPN, the cause may be on our side. Send a ticket with the status message you see and what you tried.</p>
        </>
      ),
    },
    {
      id: "credits",
      title: "I'm out of credits, or my credits look wrong",
      body: (
        <>
          <p><b>1 credit = 1 second</b> of live video. Our server counts the seconds while a session is open, and nothing is spent while you are not live.</p>
          <Ul>
            <li><b>Monthly credits</b> come with your plan ({fmtNum(plans.FREE.monthlyCredits)} on Free, {fmtNum(plans.PRO.monthlyCredits)} on Pro). They refill at the start of each month (UTC). Unused monthly credits expire and do not roll over.</li>
            <li><b>Purchased credits</b> come from top-ups, never expire, and are used only after your monthly credits run out.</li>
            <li>When the balance reaches zero the session stops by itself. To keep going, top up or upgrade on the <A href="/billing">Billing</A> page, or wait for the next monthly refill.</li>
            <li>The <A href="/dashboard">Dashboard</A> shows your balance split by kind, how much of your monthly allowance you have used, and your recent sessions with the credits each one used.</li>
          </Ul>
          <p className="mt-2">If the numbers still don&apos;t add up, send a ticket with the date and roughly what you did.</p>
        </>
      ),
    },
    {
      id: "ended",
      title: "My session ended by itself",
      body: (
        <>
          <p>A session ends on its own for one of these reasons:</p>
          <Ul>
            <li><b>You ran out of credits.</b></li>
            <li><b>You reached your plan&apos;s session length.</b> Free sessions can last up to {fmtSessionLimit(plans.FREE.maxSessionSeconds)}, Pro up to {fmtSessionLimit(plans.PRO.maxSessionSeconds)} and Lifetime up to {fmtSessionLimit(plans.LIFETIME.maxSessionSeconds)}. Start a new session to continue.</li>
            <li><b>The page stopped checking in.</b> While you are live, the Studio tells our servers every {HEARTBEAT_SECONDS} seconds that it is still there. If nothing is heard for about {STALE_AFTER_SECONDS} seconds (computer asleep, network dropped, browser crashed), the session counts as abandoned. Our cleanup closes it (or starting another session does), and it is billed up to its last check-in. If the same tab wakes up and checks in again before the session was closed, the time in between is billed too, up to your plan&apos;s session length.</li>
            <li><b>You started another session.</b> Only one live session per account runs at a time, so starting one in another tab or on another device ends the earlier one.</li>
          </Ul>
          <p className="mt-2">The <A href="/dashboard">Dashboard</A> lists your recent sessions and how each one ended.</p>
        </>
      ),
    },
    {
      id: "payments",
      title: "A payment wasn't applied, or I was charged twice",
      body: (
        <>
          <p>Start with the payment history on the <A href="/billing">Billing</A> page. Every payment is listed with a status:</p>
          <Ul>
            <li><b>success:</b> we received and verified the payment, and the plan or credits were applied.</li>
            <li><b>pending:</b> checkout was started but not confirmed yet. Confirmation comes from the payment provider and can take a few minutes, so refresh the page before assuming anything is wrong. A pending row with no charge on your bank statement is a checkout that was started and not finished; you can ignore it.</li>
            <li><b>rejected:</b> the notice we received did not match the price we expect for that item, so nothing was granted. Send a ticket.</li>
          </Ul>
          <p className="mt-2">If your bank shows a charge but Billing shows no success after you have waited, or a charge you did not expect, send a ticket with the payment reference if you have it (Billing shows it for successful payments, and if you receive receipt emails, the reference is in them), plus the date, the amount, the email you paid with and what you bought. Never put a card number or password in a ticket.</p>
          <Ul>
            <li><b>Charged twice.</b> Each checkout is its own payment with its own reference, so two successful rows are two real charges. A repeated notice from the provider for the same payment is applied only once. If your bank shows more charges than Billing does, send the details of each.</li>
            <li><b>Bought Lifetime while on Pro.</b> We ask the payment provider to stop the Pro subscription. If a Pro charge still arrives afterwards, your plan stays Lifetime and the charge can be reviewed for a refund. Contact support.</li>
            <li><b>Stopping renewals.</b> Cancel from Billing. Pro then stays active until the end of the period you paid for.</li>
          </Ul>
          <p className="mt-2">Refunds are not automatic. The app does not process them, so any refund or correction is looked at and done by hand. Our <A href="/terms">Terms</A> say payments are non-refundable except where the law requires otherwise.</p>
        </>
      ),
    },
    {
      id: "delete",
      title: "Deleting my account or my data",
      body: (
        <>
          <p>Go to <A href="/settings">Settings</A> and use Delete account (you confirm by typing DELETE). It cancels your subscriptions, deletes your files, presets, saved history, sessions, support tickets and credit records, and removes your login. Payment records are kept in anonymised form for accounting. It cannot be undone, and unused credits are lost with the account.</p>
          <p className="mt-2">To remove just one thing, delete a saved snapshot on the <A href="/history">History</A> page or a preset on the <A href="/presets">Presets</A> page. See the <A href="/privacy">Privacy Policy</A> for what is kept and why.</p>
        </>
      ),
    },
    {
      id: "video-only",
      title: "What is sent for processing? Is audio included?",
      body: (
        <>
          <p>Only video. The camera preview stays in your browser until you press Go live. From then on the Studio sends your camera video, your prompt and the reference image (if you attached one) to the AI service so it can send transformed video back.</p>
          <p className="mt-2">AltrCam does not use your microphone: it never asks for permission, and it does not capture or send audio. There is no microphone setting to fix.</p>
          <p className="mt-2">AltrCam's servers do not record or store live video (what the AI service does with it is governed by its own terms). A still is saved to History only when you press Snapshot, and on plans with clip recording, Record clip downloads a file to your own device.</p>
        </>
      ),
    },
  ];
}

export function Troubleshooting({ plans }: { plans: Record<Plan, PlanConfig> }) {
  return (
    <section aria-labelledby="troubleshooting-h" className="space-y-3">
      <div>
        <h2 id="troubleshooting-h" className="text-xl font-semibold">Troubleshooting</h2>
        <p className="text-sm text-muted-foreground">Quick answers to the common problems. If yours is not here, send a ticket below.</p>
      </div>
      {troubleshootingItems(plans).map((i) => (
        <details key={i.id} id={i.id} className="rounded-lg border bg-card p-5">
          <summary className="cursor-pointer font-medium">{i.title}</summary>
          <div className="mt-3 text-sm text-muted-foreground">{i.body}</div>
        </details>
      ))}
    </section>
  );
}
