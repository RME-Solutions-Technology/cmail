/// <reference types="@sveltejs/adapter-cloudflare" />

import type { Env as StanchionEnv, User } from '@stanchion/shared/types';

declare global {
  // adapter-cloudflare 8 reads bindings from `import { env } from 'cloudflare:workers'`.
  namespace Cloudflare {
    // Declaration merging needs an interface; it adds no members of its own.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends StanchionEnv {}
  }
  namespace App {
    interface Error {
      message: string;
      reference?: string;
    }
    interface Locals {
      user: User | null;
      sessionId: string | null;
      /** True when this request's session was opened with a passkey (docs/passkeys.md). */
      passkeySession?: boolean;
    }
    interface Platform {
      env: StanchionEnv;
      /** Only waitUntil is provided by the Workers runtime module. */
      context: Pick<ExecutionContext, 'waitUntil'>;
    }
  }
}

export {};
