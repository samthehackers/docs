import { pricesApproved } from "@/lib/pricing";

/** Shown wherever prices appear until the owner approves them (PRICING_APPROVED=true). */
export function PricingNotice() {
  if (pricesApproved()) return null;
  return (
    <p role="note" className="mx-auto mb-8 max-w-xl rounded-md border border-accent/40 bg-accent/10 p-3 text-center text-sm">
      Pricing is not final. These figures are placeholders and may change before launch.
    </p>
  );
}
