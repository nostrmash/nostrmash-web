"use client";

import { useEffect, useState } from "react";

import { relayManagerError } from "@/lib/api/endpoints/relay-manager";

type Remote<T> = { data?: T; error?: string; loading: boolean };

export function useRelayData<T>(
  load: ((signal: AbortSignal) => Promise<T>) | undefined,
  revision = 0
): Remote<T> {
  const [result, setResult] = useState<{ load: typeof load; revision: number; value: Remote<T> }>();
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted)
          setResult({ load, revision, value: { data, loading: false } });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setResult((previous) => ({
            load,
            revision,
            value: {
              data: previous?.load === load ? previous?.value.data : undefined,
              error: relayManagerError(error),
              loading: false,
            },
          }));
        }
      }
    );
    return () => controller.abort();
  }, [load, revision]);

  if (result && result.load === load) {
    return result.revision === revision
      ? result.value
      : { ...result.value, error: undefined, loading: true };
  }
  return { loading: Boolean(load) };
}
