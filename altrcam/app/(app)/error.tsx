"use client";
import { Button } from "@/components/ui/button";
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="py-24 text-center">
      <h1 className="text-2xl font-semibold">Something went sideways</h1>
      <p className="mt-2 text-muted-foreground">It's on us. Try again.</p>
      <Button className="mt-6" onClick={reset}>Retry</Button>
    </div>
  );
}
