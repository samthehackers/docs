import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseConfigured } from "@/lib/config";
import { authErrorCode, safeNextPath, sameOriginUrl } from "@/lib/safe-redirect";

/**
 * Landing point for Supabase links that carry a PKCE `code`: email confirmation, password recovery and Google OAuth
 * (the default `{{ .ConfirmationURL }}` email templates). Links using `token_hash` go to /auth/confirm instead.
 * `next` is only ever a same-origin path (see safeNextPath), so this can't be used as an open redirect.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const fail = (code: string) => NextResponse.redirect(new URL(`/sign-in?error=${code}`, url.origin));

  const error = url.searchParams.get("error") ?? url.searchParams.get("error_code");
  if (error) return fail(authErrorCode(error, url.searchParams.get("error_description")));

  const code = url.searchParams.get("code");
  if (!code) return fail("link_invalid");
  if (!supabaseConfigured()) return fail("auth_failed"); // no Auth on this deployment: never crash on a stray link
  const supabase = await createClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    console.error("[auth/callback] code exchange failed:", exchangeError.code ?? exchangeError.message);
    return fail(authErrorCode(exchangeError.code ?? "", exchangeError.message));
  }
  return NextResponse.redirect(sameOriginUrl(url.origin, safeNextPath(url.searchParams.get("next"))));
}
