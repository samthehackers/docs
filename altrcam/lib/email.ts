import { Resend } from "resend";

const brand = (title: string, body: string) => `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px">
<h2 style="margin:0 0 12px">${title}</h2><div style="color:#333;line-height:1.5">${body}</div>
<p style="color:#888;font-size:12px;margin-top:32px">AltrCam · Be anyone. Live.</p></div>`;

export async function sendEmail(to: string, subject: string, html: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn("[email] RESEND_API_KEY missing; skipping", subject); return; }
  try {
    await new Resend(key).emails.send({ from: process.env.EMAIL_FROM ?? "AltrCam <hello@altrcam.com>", to, subject, html: brand(subject, html) });
  } catch (e) {
    console.error("[email] failed", e); // email must never break fulfilment
  }
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
