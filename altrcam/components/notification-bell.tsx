"use client";
import { useState } from "react";
import { Bell } from "lucide-react";
import { relativeTime } from "@/lib/utils";

interface N { id: number; title: string; body: string; readAt: string | null; createdAt: string }

export function NotificationBell({ initial, unread }: { initial: N[]; unread: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(initial);
  const [count, setCount] = useState(unread);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && count > 0) {
      const res = await fetch("/api/notifications", { method: "POST" });
      if (res.ok) { setCount(0); setItems((x) => x.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))); }
    }
  }
  return (
    <div className="relative">
      <button onClick={toggle} aria-label={`Notifications${count ? `, ${count} unread` : ""}`} aria-expanded={open} className="relative grid h-10 w-10 place-items-center rounded-md hover:bg-muted">
        <Bell className="h-5 w-5" aria-hidden />
        {count > 0 && <span className="absolute right-1.5 top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">{count}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 z-40 mt-2 w-80 max-w-[90vw] rounded-lg border bg-card p-2 shadow-xl">
          {items.length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">You're all caught up.</p> : (
            <ul className="max-h-96 divide-y overflow-auto">
              {items.map((n) => (
                <li key={n.id} className="p-3">
                  <p className="text-sm font-medium">{n.title}</p>
                  {n.body && <p className="text-xs text-muted-foreground">{n.body}</p>}
                  <p className="mt-1 text-[11px] text-muted-foreground">{relativeTime(n.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
