import { createAdminClient, supabaseAdminConfig } from "@/lib/supabase/admin";
import { randomUUID } from "node:crypto";
import { HttpError } from "@/lib/api";

const BUCKET = "uploads";
export const UPLOAD_KINDS = ["reference", "background", "outfit", "thumbnail", "clip"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

const LIMITS: Record<UploadKind, { types: string[]; maxBytes: number }> = {
  reference: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 8_000_000 },
  background: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 8_000_000 },
  outfit: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 8_000_000 },
  thumbnail: { types: ["image/jpeg", "image/webp"], maxBytes: 1_000_000 },
  clip: { types: ["video/webm", "video/mp4"], maxBytes: 100_000_000 },
};
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/webm": "webm", "video/mp4": "mp4" };

function sb() {
  if (!supabaseAdminConfig()) throw new Error("Supabase storage not configured");
  return createAdminClient();
}

/** Signed upload URL under a per-user prefix. Type and size are validated before signing. */
export async function createSignedUpload(userId: string, kind: UploadKind, contentType: string, size: number) {
  const rule = LIMITS[kind];
  if (!rule.types.includes(contentType)) throw new HttpError(400, "Unsupported file type");
  if (size <= 0 || size > rule.maxBytes) throw new HttpError(400, `File too large (max ${Math.floor(rule.maxBytes / 1e6)}MB)`);
  const path = `${userId}/${kind}/${randomUUID()}.${EXT[contentType]}`;
  const { data, error } = await sb().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new HttpError(502, "Could not create upload URL");
  return { path, token: data.token, signedUrl: data.signedUrl };
}

/** Ownership check for any client-supplied storage path. */
export function assertOwnPath(userId: string, path: string) {
  if (!path.startsWith(`${userId}/`) || path.includes("..")) throw new HttpError(403, "Forbidden path");
}

export async function signedReadUrl(path: string, seconds = 3600) {
  const { data } = await sb().storage.from(BUCKET).createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}

export async function deleteUserFiles(userId: string) {
  const s = sb().storage.from(BUCKET);
  for (const kind of UPLOAD_KINDS) {
    const { data } = await s.list(`${userId}/${kind}`, { limit: 1000 });
    if (data?.length) await s.remove(data.map((f) => `${userId}/${kind}/${f.name}`));
  }
}

export async function deletePaths(paths: string[]) {
  if (paths.length) await sb().storage.from(BUCKET).remove(paths);
}
