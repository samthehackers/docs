import { LIVE_AVAILABILITY } from "@/lib/availability";
import { cn } from "@/lib/utils";

/** The one honest status line for the live AI video. The wording lives in lib/availability.ts. */
export function AvailabilityNotice({ className }: { className?: string }) {
  return (
    <p role="note" data-testid="live-availability" className={cn("mx-auto max-w-xl rounded-md border border-accent/40 bg-accent/10 p-3 text-left text-sm", className)}>
      <strong className="font-semibold">{LIVE_AVAILABILITY.title}.</strong> {LIVE_AVAILABILITY.body}
    </p>
  );
}
