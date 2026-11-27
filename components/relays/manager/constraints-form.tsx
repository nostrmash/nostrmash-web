"use client";

import { useState } from "react";

import { Disclosure } from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import type { RelayPreset, RelayRole } from "@/lib/api/schemas/relay-manager";
import {
  endpointFields,
  thresholdFields,
  toggleFields,
  weights,
  type ConstraintDraft,
  type Drafts,
} from "@/lib/relays/manager/constraints";
import { roleLabel, words } from "@/lib/relays/manager/presentation";

export const selectClass =
  "border-edge-strong bg-surface-sunken text-ink focus-visible:ring-accent-soft min-h-11 w-full rounded-xl border px-3 py-2 text-sm outline-none focus-visible:ring-2";
const labelClass = "text-ink-soft block min-w-0 space-y-1 text-sm";

const authChoices = {
  allow: "Allow",
  prefer_without: "Prefer without authentication",
  require: "Require authentication",
  reject: "Reject relays requiring authentication",
};

export function ConstraintsForm({
  roles,
  preset,
  drafts,
  onChange,
}: {
  roles: RelayRole[];
  preset: RelayPreset;
  drafts: Drafts;
  onChange: (drafts: Drafts) => void;
}) {
  const [activeScope, setActiveScope] = useState("global");
  const scope = roles.some((role) => role.role === activeScope) ? activeScope : "global";
  const draft = (scope === "global" ? drafts.global : drafts.byRole[scope]) ?? {};
  const role = roles.find((role) => role.role === scope);
  const countFields = role ? { min: "Minimum relays", max: "Maximum relays" } : {};

  function update(key: keyof ConstraintDraft, value: string) {
    const next = { ...draft, [key]: value };
    onChange(
      scope === "global"
        ? { ...drafts, global: next }
        : { ...drafts, byRole: { ...drafts.byRole, [scope]: next } }
    );
  }

  return (
    <Disclosure
      title="Advanced constraints"
      description="Pin relays, set limits, or override settings for a role."
    >
      <div className="space-y-4">
        <label className={labelClass}>
          Constraint scope
          <select
            className={selectClass}
            value={scope}
            onChange={(event) => setActiveScope(event.target.value)}
          >
            <option value="global">All selected roles</option>
            {roles.map((item) => (
              <option key={item.role} value={item.role}>
                {roleLabel(item.role)}
              </option>
            ))}
          </select>
        </label>
        <p className="text-ink-muted text-xs">
          Role values override global preferences. Global exclusions apply to every role. Enter one
          endpoint per line or separate them with spaces. Paid access means you can use that relay.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          {Object.entries(endpointFields).map(([key, label]) => (
            <label className={labelClass} key={key}>
              {label}
              <textarea
                className={selectClass}
                rows={2}
                maxLength={8192}
                value={draft[key as keyof ConstraintDraft] ?? ""}
                onChange={(event) => update(key as keyof ConstraintDraft, event.target.value)}
                placeholder={scope === "global" ? "wss://relay.example" : "Inherit global"}
              />
            </label>
          ))}
          {Object.entries(countFields).map(([key, label]) => (
            <label className={labelClass} key={key}>
              {label}
              <Input
                type="number"
                min={key === "max" ? 1 : 0}
                max={32}
                step={1}
                placeholder={String(key === "min" ? role?.default_min : role?.default_max)}
                value={draft[key as keyof ConstraintDraft] ?? ""}
                onChange={(event) => update(key as keyof ConstraintDraft, event.target.value)}
              />
            </label>
          ))}
          {Object.entries(thresholdFields).map(([key, label]) => (
            <label className={labelClass} key={key}>
              {label} ({key === "diversity" ? "0.2–1" : "0–1"})
              <Input
                type="number"
                min={key === "diversity" ? 0.2 : 0}
                max={1}
                step="any"
                placeholder={scope === "global" ? "Preset default" : "Inherit global"}
                value={draft[key as keyof ConstraintDraft] ?? ""}
                onChange={(event) => update(key as keyof ConstraintDraft, event.target.value)}
              />
            </label>
          ))}
          {(["auth_read", "auth_write"] as const).map((key) => (
            <label className={labelClass} key={key}>
              {key === "auth_read" ? "Read authentication" : "Write authentication"}
              <select
                className={selectClass}
                value={draft[key] ?? ""}
                onChange={(event) => update(key, event.target.value)}
              >
                <option value="">{scope === "global" ? "Preset default" : "Inherit global"}</option>
                {Object.entries(authChoices).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {Object.entries(toggleFields).map(([key, label]) => (
            <label className={labelClass} key={key}>
              {label}
              <select
                className={selectClass}
                value={draft[key as keyof ConstraintDraft] ?? ""}
                onChange={(event) => update(key as keyof ConstraintDraft, event.target.value)}
              >
                <option value="">{scope === "global" ? "Preset default" : "Inherit global"}</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
          ))}
          {preset === "custom"
            ? weights.map((key) => (
                <label className={`${labelClass} capitalize`} key={key}>
                  {words(key)} weight (0–1)
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step="any"
                    value={draft[key] ?? ""}
                    onChange={(event) => update(key, event.target.value)}
                  />
                </label>
              ))
            : null}
        </div>
      </div>
    </Disclosure>
  );
}
