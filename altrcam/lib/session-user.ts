import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { ensureUserRow } from "@/lib/users";
import { isAdmin } from "@/lib/api";

/** For server components in the authenticated app. Redirects when signed out or deleted. */
export async function requireAppUser() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  const user = await ensureUserRow(userId, async () => {
    const c = await currentUser();
    return {
      id: userId,
      email: c?.primaryEmailAddress?.emailAddress ?? "",
      name: [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.username || "",
      avatarUrl: c?.imageUrl,
    };
  });
  if (!user) redirect("/sign-in");
  return user;
}

export async function requireAdminPage() {
  const user = await requireAppUser();
  if (!(await isAdmin(user.id))) redirect("/dashboard");
  return user;
}
