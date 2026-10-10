#!/usr/bin/env node
/**
 * The pieces a bare GoTrue (Supabase Auth) needs around it to stand in for a hosted Supabase project in tests:
 *
 *   - an HTTP front door on AUTH_STACK_PORT that serves GoTrue under /auth/v1 (supabase-js always calls <url>/auth/v1/...),
 *     the way the hosted API gateway does;
 *   - GET /__templates/<name>.html: the email templates in docs/email-templates, so GoTrue sends exactly the HTML that
 *     docs/AUTH_SETUP.md tells the owner to paste into the dashboard;
 *   - an SMTP sink on AUTH_SMTP_PORT that keeps every email GoTrue sends, readable as JSON from GET /__mail
 *     (DELETE /__mail empties it).
 *
 * No dependencies. Started by scripts/local-auth.sh; see tests/integration/auth.gotrue.test.ts for how the suites use it.
 */
import http from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(here, "../../docs/email-templates");
const PORT = Number(process.env.AUTH_STACK_PORT ?? 54390);
const SMTP_PORT = Number(process.env.AUTH_SMTP_PORT ?? 54392);
const GOTRUE = process.env.GOTRUE_INTERNAL_URL ?? "http://127.0.0.1:54391";

/** @type {{ to: string[]; subject: string; html: string; at: string }[]} */
let mail = [];

/** Quoted-printable (what Go's mail writer uses for HTML bodies) back to text. */
function decodeQP(s) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseMessage(raw) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  const body = rest.join("\n\n");
  const subject = /^Subject: (.*)$/im.exec(head)?.[1]?.trim() ?? "";
  const qp = /quoted-printable/i.test(raw);
  // A multipart message: keep the text/html part.
  const htmlPart = /Content-Type: text\/html[^\n]*\n(?:[^\n]+\n)*\r?\n([\s\S]*?)(?:\r?\n--|$)/i.exec(raw)?.[1];
  const html = htmlPart ?? body;
  return { subject, html: qp ? decodeQP(html) : html };
}

net.createServer((sock) => {
  let data = false, buf = "", to = [];
  const say = (l) => sock.write(`${l}\r\n`);
  say("220 altrcam-test-smtp ESMTP");
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    if (data) {
      const end = buf.indexOf("\r\n.\r\n");
      if (end === -1) return;
      const raw = buf.slice(0, end).replace(/^\.\./gm, ".");
      buf = buf.slice(end + 5);
      data = false;
      mail.push({ to, ...parseMessage(raw), at: new Date().toISOString() });
      to = [];
      say("250 OK queued");
    }
    let i;
    while (!data && (i = buf.indexOf("\r\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") { sock.write("250-altrcam-test-smtp\r\n250 8BITMIME\r\n"); }
      else if (cmd === "HELO" || cmd === "MAIL" || cmd === "RSET" || cmd === "NOOP") say("250 OK");
      else if (cmd === "RCPT") { to.push(/<([^>]+)>/.exec(line)?.[1] ?? line); say("250 OK"); }
      else if (cmd === "DATA") { data = true; say("354 End data with <CR><LF>.<CR><LF>"); }
      else if (cmd === "QUIT") { say("221 Bye"); sock.end(); }
      else say("502 Command not implemented");
    }
  });
  sock.on("error", () => {});
}).listen(SMTP_PORT, "127.0.0.1");

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/__mail") {
    if (req.method === "DELETE") mail = [];
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(mail));
  }
  if (url.pathname.startsWith("/__templates/")) {
    const name = path.basename(url.pathname);
    try {
      const html = await readFile(path.join(TEMPLATES, name), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(404); return res.end();
    }
  }
  if (!url.pathname.startsWith("/auth/v1")) { res.writeHead(404); return res.end(); }
  const target = new URL(url.pathname.slice("/auth/v1".length) || "/", GOTRUE);
  target.search = url.search;
  const headers = { ...req.headers, host: target.host };
  const up = http.request(target, { method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end("gotrue unreachable"); });
  req.pipe(up);
}).listen(PORT, "127.0.0.1", () => console.log(`[auth-stack] http://127.0.0.1:${PORT}/auth/v1 -> ${GOTRUE}; smtp 127.0.0.1:${SMTP_PORT}`));
