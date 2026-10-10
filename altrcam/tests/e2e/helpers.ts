import postgres from "postgres";
import { cleanDatabaseUrl, databaseUrl } from "../../lib/database-url";

/** The LOCAL Supabase stack started by scripts/e2e-local.sh. Never point these at a hosted project. */
export const LOCAL = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
  secretKey: process.env.SUPABASE_SECRET_KEY ?? "",
  publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  mailpit: process.env.MAILPIT_URL ?? "http://127.0.0.1:54324",
};

const isLocal = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(u);

/** True only when a local Auth server answers. The specs skip otherwise. */
export async function localSupabaseRunning(): Promise<boolean> {
  if (!isLocal(LOCAL.supabaseUrl) || !LOCAL.secretKey) return false;
  try {
    const r = await fetch(`${LOCAL.supabaseUrl}/auth/v1/health`, { headers: { apikey: LOCAL.publishableKey } });
    return r.ok;
  } catch {
    return false;
  }
}

/** Direct database access for assertions, through the same URL resolution and cleaning the app uses. */
export const sql = () => {
  const raw = databaseUrl();
  if (!raw || !/@(127\.0\.0\.1|localhost):/.test(raw)) throw new Error("e2e helpers only talk to a local database");
  return postgres(cleanDatabaseUrl(raw).url, { prepare: false, max: 1 });
};

/** Supabase Auth admin API with the local secret key. */
export async function authAdmin(path: string, init: RequestInit = {}) {
  const r = await fetch(`${LOCAL.supabaseUrl}/auth/v1/admin/${path}`, {
    ...init,
    headers: { apikey: LOCAL.secretKey, Authorization: `Bearer ${LOCAL.secretKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`auth admin ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

interface MailSummary { ID: string; Subject: string; Created: string; To: { Address: string }[] }

/** Waits for the newest email to `to` whose subject matches, and returns the first Supabase link in it. */
export async function linkFromEmail(to: string, subject: RegExp, after: number, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${LOCAL.mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    if (r.ok) {
      const { messages } = (await r.json()) as { messages: MailSummary[] };
      const m = messages.find((x) => subject.test(x.Subject) && Date.parse(x.Created) >= after - 2000);
      if (m) {
        const full = (await (await fetch(`${LOCAL.mailpit}/api/v1/message/${m.ID}`)).json()) as { HTML: string; Text: string };
        const hrefs = [...(full.HTML ?? "").matchAll(/href="([^"]+)"/g)].map((x) => x[1].replace(/&amp;/g, "&"));
        const link = hrefs.find((h) => /\/auth\/v1\/verify|\/auth\/(callback|confirm)/.test(h)) ?? (full.Text ?? "").match(/https?:\/\/\S+\/auth\/v1\/verify\S+/)?.[0];
        if (link) return link;
      }
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`no "${subject}" email for ${to}`);
}
