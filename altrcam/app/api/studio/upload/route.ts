import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { assertOwnPath, createSignedUpload, signedReadUrl, UPLOAD_KINDS } from "@/lib/storage";
import { getUserRow } from "@/lib/users";
import { getPlan } from "@/lib/plan-config";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sign"), kind: z.enum(UPLOAD_KINDS), contentType: z.string().max(100), size: z.number().int().positive() }),
  z.object({ action: z.literal("read"), path: z.string().min(3).max(300) }),
]);

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit("upload", userId);
  const b = await parseBody(req, Body);
  if (b.action === "sign") {
    const user = await getUserRow(userId);
    if (!user) throw new HttpError(403, "Account not found");
    if (b.kind === "clip" && !(await getPlan(user.plan)).clipRecording) throw new HttpError(403, "Clip recording needs Pro");
    return NextResponse.json(await createSignedUpload(userId, b.kind, b.contentType, b.size));
  }
  assertOwnPath(userId, b.path);
  const url = await signedReadUrl(b.path);
  if (!url) throw new HttpError(404, "File not found");
  return NextResponse.json({ url });
});
