// Browser side of passkey registration (Mail > Settings > Passkeys). It only
// converts between the WebAuthn API and JSON; the server verifies everything
// (lib/server/passkeys.ts). The sign-in page has its own copy of the two
// base64url helpers because it must load without the app bundle.

export function fromBase64Url(value: string): ArrayBuffer {
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function toBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function browserSupportsPasskeys(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential === 'function'
    && !!navigator.credentials?.create;
}

interface CreationOptionsJSON {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout?: number;
  excludeCredentials?: Array<{ id: string; type: 'public-key'; transports?: string[] }>;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

/** A best guess at a friendly device name; the person can change it. */
export function suggestDeviceName(): string {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(agent)) return 'iPhone';
  if (/iPad/.test(agent)) return 'iPad';
  if (/Android/.test(agent)) return 'Android phone';
  if (/Macintosh/.test(agent)) return 'Mac';
  if (/Windows/.test(agent)) return 'Windows PC';
  if (/CrOS/.test(agent)) return 'Chromebook';
  if (/Linux/.test(agent)) return 'Linux computer';
  return 'Passkey';
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown>;
  try {
    data = await response.json() as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not add the passkey. Try again.');
  return data;
}

/** Runs the whole registration ceremony. Throws an Error with a readable message on failure. */
export async function registerPasskey(deviceName: string): Promise<void> {
  const start = await postJson('/api/passkeys/register/options', {});
  const options = start.options as CreationOptionsJSON;
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: options.rp,
        user: { id: fromBase64Url(options.user.id), name: options.user.name, displayName: options.user.displayName },
        challenge: fromBase64Url(options.challenge),
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        excludeCredentials: (options.excludeCredentials || []).map((item) => ({
          id: fromBase64Url(item.id),
          type: 'public-key' as const,
          transports: item.transports as AuthenticatorTransport[] | undefined,
        })),
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestation,
      },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'InvalidStateError') throw new Error('This device already has a passkey for your account.', { cause: error });
    if (name === 'NotAllowedError' || name === 'AbortError') throw new Error('Cancelled or timed out. Try again.', { cause: error });
    throw new Error('This device could not create a passkey.', { cause: error });
  }
  if (!(credential instanceof PublicKeyCredential)) throw new Error('This device could not create a passkey.');
  const response = credential.response as AuthenticatorAttestationResponse;
  await postJson('/api/passkeys/register/verify', {
    challengeId: start.challengeId,
    deviceName,
    response: {
      id: credential.id,
      rawId: toBase64Url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        attestationObject: toBase64Url(response.attestationObject),
        transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
      },
    },
  });
}
