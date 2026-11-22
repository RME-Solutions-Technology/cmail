import { loadColleagueSendViaExchange } from '@stanchion/shared/exchange-mirror';

/**
 * Domains whose mail lives in Exchange Online rather than in Stanchion.
 *
 * With the Exchange mirror on (docs/exchange-mirror.md), Exchange hosts the
 * organisation's mail domains (MAIL_DOMAIN and the tenant's verified
 * domains, docs/multi-domain.md) and Stanchion keeps a copy from journal reports.
 * When a manager has also turned on "Send colleague mail through Exchange"
 * (off by default), a message Stanchion would otherwise deliver straight into a
 * Stanchion mailbox on such a domain, where Exchange never sees it and so its
 * recipient would not see it in Outlook, is sent through the outbound provider
 * like any external address: Exchange delivers it, and the journal report
 * files the Stanchion copy once (the mirror's copy id is derived from the
 * Message-ID).
 *
 * With either switch off this is empty and local delivery is unchanged.
 */
export async function exchangeHostedDomains(db: D1Database, domains: readonly string[]): Promise<ReadonlySet<string>> {
  if (!domains.length) return new Set();
  return (await loadColleagueSendViaExchange(db)) ? new Set(domains) : new Set();
}
/** Mailbox rows Stanchion may deliver to directly: those not on an Exchange-hosted domain. */
export function locallyDeliverable<T extends { address: string }>(
  rows: ReadonlyArray<T>,
  hostedDomains: ReadonlySet<string>,
): T[] {
  if (!hostedDomains.size) return [...rows];
  return rows.filter((row) => {
    const address = row.address.toLowerCase();
    return !hostedDomains.has(address.slice(address.lastIndexOf('@') + 1));
  });
}

export interface RecipientDeliveryPlan {
  /** Addresses whose delivery requires the configured outbound provider. */
  externalRecipients: string[];
  /** Complete RFC-visible To list supplied to the provider. */
  providerTo: string[];
  /** Complete RFC-visible Cc list supplied to the provider. */
  providerCc: string[];
  /** Provider SMTP-envelope recipients — the visible set plus any Bcc. */
  providerRecipients: string[];
  /** Recipients that may be persisted directly without changing visible headers. */
  localRecipients: string[];
}

/**
 * A mixed local/external message needs complete visible To/Cc headers while
 * only external addresses belong in the provider envelope. The Cloudflare raw
 * transport preserves that separation; local copies remain synchronous.
 *
 * Bcc addresses are never visible headers — they only ever join the envelope
 * (external) or the direct local-delivery list (internal), regardless of
 * `separateEnvelope`. An external Bcc therefore always requires the provider
 * to support an envelope that diverges from its visible To/Cc; when it can't,
 * outbound.ts's preflight/transport checks fail the send closed rather than
 * silently exposing or dropping the Bcc'd recipient.
 */
export function planRecipientDelivery(
  to: ReadonlyArray<string>,
  cc: ReadonlyArray<string>,
  bcc: ReadonlyArray<string>,
  internalAddresses: ReadonlySet<string>,
  separateEnvelope = true,
): RecipientDeliveryPlan {
  const visible = [...to, ...cc];
  const externalVisible = visible.filter((address) => !internalAddresses.has(address));
  const localVisible = visible.filter((address) => internalAddresses.has(address));
  const externalBcc = bcc.filter((address) => !internalAddresses.has(address));
  const localBcc = bcc.filter((address) => internalAddresses.has(address));

  if (!externalVisible.length && !externalBcc.length) {
    return {
      externalRecipients: [],
      providerTo: [],
      providerCc: [],
      providerRecipients: [],
      localRecipients: [...localVisible, ...localBcc],
    };
  }
  return {
    externalRecipients: externalVisible,
    providerTo: [...to],
    providerCc: [...cc],
    providerRecipients: separateEnvelope
      ? [...externalVisible, ...externalBcc]
      : [...visible, ...externalBcc],
    localRecipients: separateEnvelope ? [...localVisible, ...localBcc] : localBcc,
  };
}
