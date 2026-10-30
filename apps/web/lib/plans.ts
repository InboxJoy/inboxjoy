export type PlanKey = "lifetime";

export type PlanOffer = {
  key: PlanKey;
  name: string;
  price: string;
  regularPrice?: string;
  period: string;
  tagline: string;
  badge?: string;
  support?: string;
};

// Single source for plan names and prices: the marketing pricing cards and the
// in-app plan picker both render from this list.
export const planOffers: readonly PlanOffer[] = [
  {
    key: "lifetime",
    name: "Lifetime license",
    price: "79",
    period: "one-time",
    tagline: "Pay once. No subscription, no renewals.",
    support: "30-day money-back guarantee.",
  },
];

export function isPlanKey(value: unknown): value is PlanKey {
  return value === "lifetime";
}
