import type { UnsignedEvent } from "@/lib/api/schemas/relay-manager";

export interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<unknown>;
}

export function browserSigner(): Partial<NostrSigner> | undefined {
  return (window as Window & { nostr?: Partial<NostrSigner> }).nostr;
}

export function nip07Signer(): NostrSigner | undefined {
  const extension = browserSigner();
  if (!extension?.getPublicKey || !extension.signEvent) return undefined;
  return {
    getPublicKey: extension.getPublicKey.bind(extension),
    signEvent: extension.signEvent.bind(extension),
  };
}
