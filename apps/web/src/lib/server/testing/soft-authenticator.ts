// Test-only software WebAuthn authenticator: a P-256 (ES256) key, packed as a
// real authenticator would (CBOR attestation object with fmt 'none', DER
// signatures), so tests drive @simplewebauthn/server with generated
// credentials. Imported only by *.test.ts files.

const encoder = new TextEncoder();

export function base64Url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  let base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ─── Minimal CBOR encoder (the subset WebAuthn needs) ──────────────────

type CborValue = number | string | Uint8Array | CborValue[] | Map<number | string, CborValue>;

function cborHead(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 0x100) return Uint8Array.of((major << 5) | 24, length);
  if (length < 0x10000) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
  return Uint8Array.of((major << 5) | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
}

export function cbor(value: CborValue): Uint8Array {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = encoder.encode(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  if (Array.isArray(value)) return concat(cborHead(4, value.length), ...value.map(cbor));
  const entries = [...value.entries()];
  return concat(cborHead(5, entries.length), ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)]));
}

// ─── DER signature (WebAuthn ES256 signatures are ASN.1 DER) ────────────

function derInteger(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start += 1;
  let body: Uint8Array<ArrayBuffer> = Uint8Array.from(raw.subarray(start));
  if (body[0] & 0x80) body = concat(Uint8Array.of(0), body);
  return concat(Uint8Array.of(0x02, body.length), body);
}

function rawToDer(raw: Uint8Array): Uint8Array {
  const r = derInteger(raw.slice(0, 32));
  const s = derInteger(raw.slice(32));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export interface SoftAuthenticatorOptions {
  rpId: string;
  origin: string;
}

export class SoftAuthenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(32));
  counter = 0;
  userHandle: Uint8Array | null = null;
  private keys!: CryptoKeyPair;

  static async create(): Promise<SoftAuthenticator> {
    const authenticator = new SoftAuthenticator();
    authenticator.keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    return authenticator;
  }

  get id(): string {
    return base64Url(this.credentialId);
  }

  private async coseKey(): Promise<Uint8Array> {
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    return cbor(new Map<number, CborValue>([
      [1, 2], [3, -7], [-1, 1], [-2, fromBase64Url(jwk.x!)], [-3, fromBase64Url(jwk.y!)],
    ]));
  }

  /**
   * Answers a registration ceremony. `overrides` lets a test forge one field
   * (origin, rpId, flags, type) to check that the server refuses it.
   */
  async register(
    options: { challenge: string; user: { id: string } },
    rp: SoftAuthenticatorOptions,
    overrides: { origin?: string; rpId?: string; flags?: number; type?: string } = {},
  ): Promise<Record<string, unknown>> {
    this.userHandle = fromBase64Url(options.user.id);
    const clientDataJSON = encoder.encode(JSON.stringify({
      type: overrides.type ?? 'webauthn.create',
      challenge: options.challenge,
      origin: overrides.origin ?? rp.origin,
      crossOrigin: false,
    }));
    const idLength = Uint8Array.of(this.credentialId.length >> 8, this.credentialId.length & 0xff);
    const authData = concat(
      await sha256(encoder.encode(overrides.rpId ?? rp.rpId)),
      Uint8Array.of(overrides.flags ?? 0x45), // UP | UV | AT
      Uint8Array.of(0, 0, 0, this.counter),
      new Uint8Array(16), // AAGUID
      idLength,
      this.credentialId,
      await this.coseKey(),
    );
    const attestationObject = cbor(new Map<string, CborValue>([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', authData],
    ]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64Url(clientDataJSON),
        attestationObject: base64Url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** Answers a sign-in ceremony; bumps the counter unless `counter` is given. */
  async authenticate(
    challenge: string,
    rp: SoftAuthenticatorOptions,
    overrides: { origin?: string; rpId?: string; flags?: number; counter?: number; userHandle?: string | null; type?: string } = {},
  ): Promise<Record<string, unknown>> {
    const counter = overrides.counter ?? (this.counter += 1);
    const clientDataJSON = encoder.encode(JSON.stringify({
      type: overrides.type ?? 'webauthn.get',
      challenge,
      origin: overrides.origin ?? rp.origin,
      crossOrigin: false,
    }));
    const authData = concat(
      await sha256(encoder.encode(overrides.rpId ?? rp.rpId)),
      Uint8Array.of(overrides.flags ?? 0x05), // UP | UV
      Uint8Array.of((counter >>> 24) & 0xff, (counter >> 16) & 0xff, (counter >> 8) & 0xff, counter & 0xff),
    );
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed));
    const userHandle = overrides.userHandle === undefined
      ? (this.userHandle ? base64Url(this.userHandle) : undefined)
      : overrides.userHandle ?? undefined;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64Url(clientDataJSON),
        authenticatorData: base64Url(authData),
        signature: base64Url(rawToDer(raw)),
        userHandle,
      },
    };
  }
}
