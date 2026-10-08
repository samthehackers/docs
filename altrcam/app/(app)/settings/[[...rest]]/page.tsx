import { UserProfile } from "@clerk/nextjs";
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
      <div className="overflow-x-auto"><UserProfile routing="path" path="/settings" appearance={{ elements: { rootBox: "w-full", cardBox: "w-full max-w-none shadow-none" } }} /></div>
      <Card className="border-destructive/40"><h2 className="mb-3 font-semibold text-destructive">Delete account</h2><DeleteAccount /></Card>
    </div>
  );
}
