import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { authErrorCode, safeNextPath } from "@/lib/safe-redirect";

const TYPES: EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

/**
 * Landing point for Supabase email templates written in the `token_hash` style, e.g.
 * `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/settings/password`.
 * Unlike the PKCE `code` flow it works when the link is opened in a different browser from the one that asked for it.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const fail = (code: string) => NextResponse.redirect(new URL(`/sign-in?error=${code}`, url.origin));

  const error = url.searchParams.get("error") ?? url.searchParams.get("error_code");
  if (error) return fail(authErrorCode(error, url.searchParams.get("error_description")));

  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  if (!tokenHash || !type || !TYPES.includes(type)) return fail("link_invalid");

  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (verifyError) {
    console.error("[auth/confirm] verifyOtp failed:", verifyError.code ?? verifyError.message);
    return fail(authErrorCode(verifyError.code ?? "", verifyError.message));
  }
  const fallback = type === "recovery" ? "/settings/password" : "/dashboard";
  return NextResponse.redirect(new URL(safeNextPath(url.searchParams.get("next"), fallback), url.origin));
}
