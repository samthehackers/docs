import { Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PRODUCTS, type Plan, type PlanConfig, type ProductId } from "@/lib/plans";
import { priceLabel } from "@/lib/pricing";
import { planFeatures } from "@/lib/public-copy";

interface Tier { key: "FREE" | "PRO" | "LIFETIME"; product?: ProductId; price: string; cadence: string; highlight?: boolean; badge?: string }

export function tiers(): Tier[] {
  return [
    { key: "FREE", price: "Free", cadence: "no card needed" },
    { key: "PRO", product: "PRO_MONTHLY", price: priceLabel("PRO_MONTHLY"), cadence: "per month", highlight: true, badge: "Subscription" },
    { key: "LIFETIME", product: "LIFETIME", price: priceLabel("LIFETIME"), cadence: "one time" },
  ];
}

export function PricingCards({ plans, renderCta, current }: { plans: Record<Plan, PlanConfig>; renderCta: (t: Tier) => React.ReactNode; current?: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {tiers().map((t) => {
        const p = plans[t.key];
        return (
          <Card key={t.key} className={t.highlight ? "border-primary glow" : ""}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">{p.label}</h3>
              {t.badge && <Badge>{t.badge}</Badge>}
              {current === t.key && <Badge>Current</Badge>}
            </div>
            <p className="mt-4 text-4xl font-bold">{t.price}</p>
            <p className="text-sm text-muted-foreground">{t.cadence}</p>
            <ul className="mt-6 space-y-2 text-sm">
              {planFeatures(p).map((f) => (
                <li key={f} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />{f}</li>
              ))}
            </ul>
            <div className="mt-6">{renderCta(t)}</div>
          </Card>
        );
      })}
    </div>
  );
}

export function TopupList({ renderCta }: { renderCta: (id: ProductId) => React.ReactNode }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {(["TOPUP_1K", "TOPUP_5K", "TOPUP_15K"] as ProductId[]).map((id) => (
        <Card key={id}>
          <p className="font-semibold">{PRODUCTS[id].label}</p>
          <p className="text-2xl font-bold">{priceLabel(id)}</p>
          <p className="mb-4 text-xs text-muted-foreground">Never expire</p>
          {renderCta(id)}
        </Card>
      ))}
    </div>
  );
}
