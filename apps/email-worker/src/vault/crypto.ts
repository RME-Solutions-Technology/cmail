// Vault cryptography (docs/secret-vault.md). AES-256-GCM with a data key
// derived by HKDF-SHA-256 from the Worker secret CMAIL_VAULT_KEY. Every
// ciphertext is bound to its row by additional authenticated data (AAD), so
// it cannot be swapped between rows, names, versions or purposes. Error
// messages are fixed codes: no value, key or ciphertext ever reaches a log.
import type { VaultErrorCode, VaultKeyState } from '@stanchion/shared/secret-vault';

export interface VaultKeyEnv {
  /** 32 random bytes, base64 or base64url. The client keeps a copy in its password manager. */
  CMAIL_VAULT_KEY?: string;
  /** The previous key, set only while rotating; remove after rewrap. */
  CMAIL_VAULT_KEY_PREVIOUS?: string;
}

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode) {
    super(code);
    this.name = 'VaultError';
  }
}

interface KeyEntry {
  id: string;
  key: CryptoKey;
}

export interface VaultKeyring {
  current: KeyEntry | null;
  previous: KeyEntry | null;
  currentState: VaultKeyState;
  previousState: VaultKeyState;
}

export interface SealedValue {
  kekId: string;
  iv: string;
  ciphertext: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT = new TextEncoder().encode('cmail-vault/v1');
const DATA_KEY_INFO = new TextEncoder().encode('cmail-vault/v1 data-key aes-256-gcm');
const KEY_ID_INFO = new TextEncoder().encode('cmail-vault/v1 key-id');
/** Scheme prefix of every key id; a future scheme gets a new prefix. */
export const KEK_ID_PREFIX = 'v1-';
const AAD_PART = /^[A-Za-z0-9._:-]{1,64}$/;

export function decodeKeyMaterial(raw: string): Uint8Array<ArrayBuffer> | null {
  const text = raw.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!text || !/^[A-Za-z0-9+/]+$/.test(text)) return null;
  try {
    const binary = atob(text + '='.repeat((4 - (text.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return bytes.length === KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

async function deriveEntry(raw: string | undefined): Promise<{ state: VaultKeyState; entry: KeyEntry | null }> {
  if (typeof raw !== 'string' || !raw.trim()) return { state: 'missing', entry: null };
  const bytes = decodeKeyMaterial(raw);
  if (!bytes) return { state: 'invalid', entry: null };
  const base = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey', 'deriveBits']);
  bytes.fill(0);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: DATA_KEY_INFO },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  // The key id is a separate HKDF output (domain-separated by info), so it
  // reveals nothing about the data key; 64 bits is plenty to tell keys apart.
  const idBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: KEY_ID_INFO }, base, 64));
  const id = KEK_ID_PREFIX + Array.from(idBits, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { state: 'ok', entry: { id, key } };
}

export async function loadKeyring(env: VaultKeyEnv): Promise<VaultKeyring> {
  const [current, previous] = await Promise.all([deriveEntry(env.CMAIL_VAULT_KEY), deriveEntry(env.CMAIL_VAULT_KEY_PREVIOUS)]);
  return {
    current: current.entry,
    previous: previous.entry && previous.entry.id !== current.entry?.id ? previous.entry : null,
    currentState: current.state,
    previousState: previous.state,
  };
}

/** The AAD: a fixed context label plus row-identifying parts, newline-separated. */
export function additionalData(context: string, parts: readonly (string | number)[]): Uint8Array<ArrayBuffer> {
  const items = [context, ...parts.map(String)];
  for (const item of items) if (!AAD_PART.test(item)) throw new VaultError('invalid_request');
  return new TextEncoder().encode(items.join('\n'));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    throw new VaultError('decrypt_failed');
  }
}

export async function seal(keyring: VaultKeyring, aad: Uint8Array<ArrayBuffer>, plaintext: string): Promise<SealedValue> {
  if (!keyring.current) throw new VaultError(keyring.currentState === 'invalid' ? 'vault_key_invalid' : 'vault_key_missing');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, keyring.current.key, data));
  data.fill(0);
  return { kekId: keyring.current.id, iv: toBase64(iv), ciphertext: toBase64(sealed) };
}

export async function open(keyring: VaultKeyring, aad: Uint8Array<ArrayBuffer>, sealed: SealedValue): Promise<string> {
  const entry = [keyring.current, keyring.previous].find((candidate) => candidate?.id === sealed.kekId);
  if (!entry) {
    if (!keyring.current) throw new VaultError(keyring.currentState === 'invalid' ? 'vault_key_invalid' : 'vault_key_missing');
    throw new VaultError('key_unavailable');
  }
  const iv = fromBase64(sealed.iv);
  if (iv.length !== IV_BYTES) throw new VaultError('decrypt_failed');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, entry.key, fromBase64(sealed.ciphertext));
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    // Wrong key, tampered ciphertext, or AAD that does not match this row.
    throw new VaultError('decrypt_failed');
  }
}
