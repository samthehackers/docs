import { cache } from "react";
import { redirect } from "next/navigation";
import { ensureUserRow } from "@/lib/users";
import { isAdmin } from "@/lib/api";
import { createClient } from "@/lib/supabase/server";

/** For server components in the authenticated app. Redirects when signed out or deleted. */
export const requireAppUser = cache(async () => {
  const supabase = await createClient();
  const { data: { user: sessionUser } } = await supabase.auth.getUser();
  if (!sessionUser) redirect("/sign-in");
  const user = await ensureUserRow(sessionUser.id, async () => ({
    id: sessionUser.id,
    email: sessionUser.email ?? "",
    name: sessionUser.user_metadata?.full_name ?? sessionUser.user_metadata?.name ?? "",
    avatarUrl: sessionUser.user_metadata?.avatar_url ?? null,
  }));
  if (!user) redirect("/sign-in");
  return user;
});

/**
 * Admin gate for server components and for the admin data functions. Memoised per request (React cache), so calling it
 * from the page and from every query costs one Clerk lookup. Outside a React render, `cache` simply calls through.
 */
export const requireAdminPage = cache(async () => {
  const user = await requireAppUser();
  if (!(await isAdmin(user.id))) redirect("/dashboard");
  return user;
});
