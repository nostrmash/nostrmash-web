#!/usr/bin/env node
/**
 * Print every pnpm audit advisory and fail on anything that is not an
 * explicit, reviewed exception. Exceptions live in
 * security/accepted-advisories.json. Vite is never an exception.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const allowlistPath = new URL("../security/accepted-advisories.json", import.meta.url);
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
const accepted = new Map((allowlist.advisories ?? []).map((entry) => [entry.id, entry]));

const result = spawnSync("pnpm", ["audit", "--json"], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});

const stdout = result.stdout?.trim() ?? "";
if (!stdout) {
  console.error(result.stderr);
  process.exit(result.status === 0 ? 0 : (result.status ?? 1));
}

let data;
try {
  data = JSON.parse(stdout);
} catch {
  if (result.status === 0 && /no known vulnerabilities/i.test(stdout)) {
    data = { advisories: {} };
  } else {
    console.error(stdout);
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
}

const advisories = Object.values(data.advisories ?? {});
const seen = new Set();
const unexpected = [];

if (advisories.length === 0) {
  console.log("pnpm audit: no known vulnerabilities.");
} else {
  console.log(`pnpm audit: ${advisories.length} advisories.`);
}

for (const advisory of advisories) {
  const id = ghsaId(advisory);
  const paths = [...new Set((advisory.findings ?? []).flatMap((finding) => finding.paths ?? []))];
  seen.add(id);
  const entry = accepted.get(id);
  const blocked =
    advisory.module_name === "vite" ||
    paths.some((path) => path.endsWith(">vite") || path.includes(">vite>"));
  const status = !entry || blocked ? "FAIL" : "accepted";
  console.log(
    `\n[${status}] ${advisory.severity} ${advisory.module_name} ${id}\n  ${advisory.title}\n  ${advisory.url}\n  ${paths.join("\n  ") || "(no path)"}`
  );
  if (!entry || blocked) {
    unexpected.push(id || advisory.module_name);
    continue;
  }
  if (entry.package && entry.package !== advisory.module_name) {
    unexpected.push(`${id} package mismatch`);
  }
}

const stale = [...accepted.keys()].filter((id) => !seen.has(id));
if (stale.length > 0) {
  console.error(`\nStale audit exceptions (no longer reported): ${stale.join(", ")}`);
}

if (unexpected.length > 0 || stale.length > 0) {
  console.error(
    "\nDependency audit failed. Patch the package, or add a reviewed exception with a reason."
  );
  process.exit(1);
}

if (accepted.size > 0) {
  console.log(
    "\nAccepted advisories are dev or build tooling and are not reachable from the deployed Worker. See security/accepted-advisories.json."
  );
}

function ghsaId(advisory) {
  const match = String(advisory.url ?? "").match(/GHSA-[0-9a-z-]+/i);
  return match ? match[0] : String(advisory.id ?? advisory.title);
}
