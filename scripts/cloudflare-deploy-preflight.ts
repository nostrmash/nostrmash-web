import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  bucketNameFromWranglerConfig,
  inspectCloudflareCredentials,
  runLiveChecks,
  type CommandResult,
} from "../lib/deploy/cloudflare-preflight";

function runWrangler(
  args: string[],
  env: Record<string, string | undefined>
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
    };
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") childEnv[key] = value;
    }
    const child = spawn("pnpm", ["exec", "wrangler", ...args], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcess;
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (/oauth2\/auth|Attempting to login via OAuth/i.test(output)) {
        child.kill("SIGTERM");
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: error.message });
    });
  });
}

async function main(): Promise<number> {
  const credentials = inspectCloudflareCredentials(process.env);
  if (!credentials.ok) {
    process.stderr.write(`${credentials.message}\n`);
    return 2;
  }
  if (!process.argv.includes("--live")) {
    process.stdout.write(
      "Cloudflare credentials are present. Live account and bucket checks were not requested.\n"
    );
    return 0;
  }

  let source = "";
  try {
    source = readFileSync("wrangler.jsonc", "utf8");
  } catch (error) {
    process.stderr.write(
      `Could not read wrangler.jsonc (${error instanceof Error ? error.message : "unknown error"}). Deployment was not started.\n`
    );
    return 2;
  }

  const result = await runLiveChecks({
    env: process.env,
    run: runWrangler,
    bucketName: bucketNameFromWranglerConfig(source),
  });
  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    return result.kind === "missing_credentials" || result.kind === "malformed_credentials" ? 2 : 1;
  }
  process.stdout.write(
    "Cloudflare preflight passed. The token can see the configured account and the OpenNext cache bucket. Deployment has not been started by this check.\n"
  );
  return 0;
}

void main().then((code) => {
  process.exit(code);
});
