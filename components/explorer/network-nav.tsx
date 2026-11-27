import { TabBar } from "@/components/ui/tabs";

export type NetworkView = "overview" | "relays" | "health" | "manager";

const NETWORK_VIEWS = [
  { key: "overview", label: "Overview", href: "/relays" },
  { key: "relays", label: "Popular relays", href: "/relays/popular" },
  { key: "health", label: "Status", href: "/relays/health" },
  { key: "manager", label: "Relay Manager", href: "/relays/manager" },
] as const;

export function NetworkNav({ active }: { active?: NetworkView }) {
  return (
    <TabBar
      ariaLabel="Network sections"
      prefetch
      items={NETWORK_VIEWS.map((view) => ({ ...view, active: view.key === active }))}
    />
  );
}
