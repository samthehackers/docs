"use client";
import { useEffect } from "react";
import { ErrorScreen } from "@/components/error-screen";

/**
 * Catches errors in any page or layout below the root layout that has no closer boundary: the marketing and auth pages, and the
 * signed-in shell's own layout (app/(app)/error.tsx only covers the pages inside that layout).
 */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <ErrorScreen reset={reset} digest={error.digest} />;
}
