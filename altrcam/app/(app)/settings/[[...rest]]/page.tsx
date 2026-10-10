import { Card } from "@/components/ui/card";
import { DeleteAccount, NotifyToggle } from "@/components/settings-forms";
import { requireAppUser } from "@/lib/session-user";

export const metadata = { title: "Settings" };

export default async function Settings() {
  const user = await requireAppUser();
  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Settings</h1>
      <Card><h2 className="mb-3 font-semibold">Notifications</h2><NotifyToggle initial={user.notifyEmail} /></Card>
      <Card>
        <h2 className="mb-3 font-semibold">Account</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Email</dt><dd className="font-medium">{user.email}</dd></div>
          <div><dt className="text-muted-foreground">Name</dt><dd className="font-medium">{user.name || "Not set"}</dd></div>
        </dl>
      </Card>
      <Card className="border-destructive/40"><h2 className="mb-3 font-semibold text-destructive">Delete account</h2><DeleteAccount /></Card>
    </div>
  );
}
