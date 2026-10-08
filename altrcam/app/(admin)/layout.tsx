import { requireAdminPage } from "@/lib/session-user";
import { Logo } from "@/components/logo";
import Link from "next/link";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage(); // server-side gate; every /api/admin handler re-checks independently
  return (
    <div className="min-h-screen">
      <header className="border-b"><div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4"><Logo href="/dashboard" /><span className="text-sm font-semibold text-accent">Admin</span><Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">Back to app</Link></div></header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
