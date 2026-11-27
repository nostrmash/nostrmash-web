import type { Metadata } from "next";
import { Suspense } from "react";

import { NetworkNav } from "@/components/explorer/network-nav";
import { PageHero } from "@/components/explorer/page-hero";
import { ManagerSkeleton, RelayManager } from "@/components/relays/manager/relay-manager";

export const metadata: Metadata = {
  title: "Relay Manager",
  description:
    "Inspect a Nostr account’s relay configuration and review role-specific relay recommendations.",
  alternates: { canonical: "/relays/manager" },
};

export default function RelayManagerPage() {
  return (
    <article className="space-y-5 sm:space-y-7">
      <PageHero eyebrow="Network" title="Relay Manager" />
      <NetworkNav active="manager" />
      <Suspense fallback={<ManagerSkeleton label="Loading Relay Manager…" />}>
        <RelayManager />
      </Suspense>
    </article>
  );
}
