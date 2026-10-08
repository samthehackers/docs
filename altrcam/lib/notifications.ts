import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { notifications, users } from "@/db/schema";
import type { DB, Tx } from "@/lib/db";

export async function notify(r: DB | Tx, userId: string, type: string, title: string, body = "") {
  await r.insert(notifications).values({ userId, type, title, body });
}

export async function listNotifications(r: DB, userId: string) {
  return r.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(30);
}

export async function unreadCount(r: DB, userId: string) {
  const [row] = await r.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

export async function markAllRead(r: DB, userId: string) {
  await r.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}

export async function userEmailIfEnabled(r: DB | Tx, userId: string) {
  const [u] = await r.select({ email: users.email, on: users.notifyEmail }).from(users).where(eq(users.id, userId));
  return u && u.on ? u.email : null;
}
