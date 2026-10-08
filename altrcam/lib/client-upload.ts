/** Browser helper: signed upload to Supabase Storage via our API (no Supabase client in the browser). */
export type UploadKind = "reference" | "background" | "outfit" | "thumbnail" | "clip";

export async function uploadFile(kind: UploadKind, file: Blob): Promise<string> {
  const signRes = await fetch("/api/studio/upload", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sign", kind, contentType: file.type, size: file.size }),
  });
  if (!signRes.ok) throw new Error((await signRes.json().catch(() => ({}))).error ?? "Upload failed");
  const { signedUrl, path } = await signRes.json();
  const fd = new FormData();
  fd.append("cacheControl", "3600");
  fd.append("", file);
  const put = await fetch(signedUrl, { method: "PUT", body: fd });
  if (!put.ok) throw new Error("Upload failed");
  return path as string;
}

export async function readUrl(path: string): Promise<string> {
  const r = await fetch("/api/studio/upload", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "read", path }),
  });
  if (!r.ok) throw new Error("Could not read file");
  return (await r.json()).url as string;
}
