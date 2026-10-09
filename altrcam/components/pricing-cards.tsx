import { Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PRODUCTS, type Plan, type PlanConfig, type ProductId } from "@/lib/plans";
import { planFeatures } from "@/lib/public-copy";

/** One plan card. Built by the page from the offers that are actually on sale; a paid plan with no offer is not passed in. */
export interface Tier { key: Plan; product?: ProductId; price: string; cadence: string; highlight?: boolean; badge?: string; note?: string }

export function PricingCards({ plans, tiers, renderCta, current }: { plans: Record<Plan, PlanConfig>; tiers: Tier[]; renderCta: (t: Tier) => React.ReactNode; current?: string }) {
  return (
    <div className={`grid gap-4 ${tiers.length >= 3 ? "md:grid-cols-3" : tiers.length === 2 ? "md:grid-cols-2" : ""}`}>
      {tiers.map((t) => {
        const p = plans[t.key];
        return (
          <Card key={t.key} className={t.highlight ? "border-primary glow" : ""}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-lg font-semibold">{p.label}</h3>
              {t.badge && <Badge>{t.badge}</Badge>}
              {current === t.key && <Badge>Current plan</Badge>}
            </div>
            <p className="mt-4 text-4xl font-bold">{t.price}</p>
            <p className="text-sm text-muted-foreground">{t.cadence}</p>
            {t.note && <p className="mt-2 text-xs text-muted-foreground">{t.note}</p>}
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

export interface TopupItem { id: ProductId; price: string; note?: string }

export function TopupList({ items, renderCta }: { items: TopupItem[]; renderCta: (id: ProductId) => React.ReactNode }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {items.map(({ id, price, note }) => (
        <Card key={id}>
          <p className="font-semibold">{PRODUCTS[id].label}</p>
          <p className="text-2xl font-bold">{price}</p>
          <p className="mb-4 text-xs text-muted-foreground">Never expire{note ? `. ${note}` : ""}</p>
          {renderCta(id)}
        </Card>
      ))}
    </div>
  );
}
