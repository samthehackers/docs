"use client";
import { useEffect } from "react";
import { ErrorScreen } from "@/components/error-screen";
import "./globals.css";

/** Last resort: the root layout itself failed, so this replaces it and must bring its own <html> and <body>. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen">
        <title>Something went wrong · AltrCam</title>
        <ErrorScreen reset={reset} digest={error.digest} />
      </body>
    </html>
  );
}
