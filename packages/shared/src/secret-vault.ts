// Secret vault (docs/secret-vault.md): the names the vault may hold, the
// private RPC operations the web app may call on the email Worker, and the
// shapes those operations return. Shared so the web app and the Worker agree
// on one allow-list. Nothing here holds or derives key material.

/**
 * Every secret the vault may hold. `envName` is the Worker secret that, when
 * set, always wins over the vault (env-first): existing deployments keep
 * working unchanged and the vault is read only for values the setup wizard
 * stored. `null` means the value only ever lives in the vault (for example a
 * private key cMail generated itself). `purpose` is bound into the
 * ciphertext's additional authenticated data, so a row encrypted for one
 * purpose never decrypts as another.
 */
export const VAULT_SECRETS = {
  'm365.sync.client_secret': { envName: 'M365_CLIENT_SECRET', purpose: 'entra-client-secret', maxBytes: 1024 },
  'm365.copyback.client_secret': { envName: 'M365_COPYBACK_CLIENT_SECRET', purpose: 'entra-client-secret', maxBytes: 1024 },
  'm365.perms.cert_pfx_b64': { envName: 'M365_EXO_CERT_PFX_B64', purpose: 'exo-certificate', maxBytes: 16384 },
  'm365.perms.cert_password': { envName: 'M365_EXO_CERT_PASSWORD', purpose: 'exo-certificate-password', maxBytes: 1024 },
  'm365.journal.address': { envName: 'M365_JOURNAL_ADDRESS', purpose: 'journal-address', maxBytes: 320 },
  'entra.signin.private_key': { envName: null, purpose: 'entra-app-private-key', maxBytes: 8192 },
  'entra.sync.private_key': { envName: null, purpose: 'entra-app-private-key', maxBytes: 8192 },
  'entra.perms.private_key': { envName: null, purpose: 'entra-app-private-key', maxBytes: 8192 },
} as const satisfies Record<string, { envName: string | null; purpose: string; maxBytes: number }>;

export type VaultSecretName = keyof typeof VAULT_SECRETS;

export function isVaultSecretName(value: unknown): value is VaultSecretName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VAULT_SECRETS, value);
}

/** The private-binding base URL; the Worker refuses every other hostname. */
export const VAULT_RPC_BASE = 'https://cmail-email-worker.internal/internal/vault/';

/**
 * The only vault operations reachable over the EMAIL_SERVICE binding. There
 * is deliberately no "get", "decrypt" or "export": values never leave the
 * email Worker. Later wizard PRs add narrowly scoped operations (for example
 * "sign a client assertion") here, one at a time.
 */
export const VAULT_RPC_OPERATIONS = ['status', 'put', 'retire', 'rewrap'] as const;
export type VaultRpcOperation = typeof VAULT_RPC_OPERATIONS[number];

export function isVaultRpcOperation(value: unknown): value is VaultRpcOperation {
  return typeof value === 'string' && (VAULT_RPC_OPERATIONS as readonly string[]).includes(value);
}

/** Stable error codes; never carries a value, key or ciphertext. */
export type VaultErrorCode =
  | 'vault_key_missing'
  | 'vault_key_invalid'
  | 'key_unavailable'
  | 'decrypt_failed'
  | 'not_installed'
  | 'unknown_name'
  | 'invalid_value'
  | 'invalid_request'
  | 'write_conflict';

export type VaultKeyState = 'ok' | 'missing' | 'invalid';

export interface VaultSecretStatus {
  name: VaultSecretName;
  /** The env secret is set, so it wins and the vault row (if any) is unused. */
  envSet: boolean;
  /** Which source a reader would use now: env, vault or none. */
  source: 'env' | 'vault' | 'none';
  version: number | null;
  kekId: string | null;
  /** True when the active row is under a key that is not the current one (run rewrap). */
  needsRewrap: boolean;
  notAfter: number | null;
  createdAt: number | null;
}

export interface VaultStatus {
  installed: boolean;
  keyState: VaultKeyState;
  /** Current key id (not secret: a short HKDF-derived fingerprint). */
  currentKekId: string | null;
  previousKeyState: VaultKeyState;
  secrets: VaultSecretStatus[];
}
