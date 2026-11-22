// The /auth/passkey sign-in page, built as one self-contained HTML response.
//
// Why not a Svelte page: behind Cloudflare Access only /auth/passkey is
// excluded from the gate (docs/passkeys.md). The app's /_app/* bundles, fonts
// and logo stay behind Access, so a Svelte page here could not load them
// while Microsoft is down. This page needs nothing outside /auth/passkey: its
// only script is /auth/passkey/client.js and its styles are inline.
//
// The script is plain browser JavaScript (no build step) and only moves bytes
// between the WebAuthn API and the two JSON endpoints. All verification is on
// the server (passkeys.ts, @simplewebauthn/server).
import { escapeHtml } from './validation';

/** Strict CSP for both responses: same-origin script only, nothing else loads. */
export const PASSKEY_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function renderPasskeySignInPage(options: { appName: string; orgName: string }): string {
  const appName = escapeHtml(options.appName || 'Stanchion');
  const orgName = escapeHtml(options.orgName || '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in with a passkey · ${appName}</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --text: #1b1b1f; --muted: #5d5f66; --primary: #0f6cbd; --on-primary: #ffffff; --danger: #b3261e; --border: #d0d3da; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16171a; --text: #ececf1; --muted: #a9acb5; --primary: #4ea1f3; --on-primary: #0b1220; --danger: #ff8a80; --border: #3a3d45; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  main { width: 100%; max-width: 420px; text-align: center; }
  h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
  p { margin: 0 0 18px; color: var(--muted); }
  button { width: 100%; min-height: 44px; padding: 10px 14px; border: 0; border-radius: 6px; background: var(--primary); color: var(--on-primary); font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: progress; }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  #passkey-status { min-height: 1.5em; margin: 14px 0 0; color: var(--text); }
  #passkey-status.error { color: var(--danger); }
  .other { margin-top: 22px; font-size: 13px; }
  a { color: var(--primary); }
  .note { margin-top: 28px; font-size: 12px; text-align: left; border-top: 1px solid var(--border); padding-top: 12px; }
</style>
</head>
<body>
<main id="main-content">
  <h1>Sign in with a passkey</h1>
  <p>${orgName ? `${orgName} · ` : ''}${appName}. Use the passkey you added while signed in the normal way.</p>
  <button type="button" id="passkey-button" disabled>Use a passkey</button>
  <div id="passkey-status" role="status" aria-live="polite"></div>
  <noscript><p>Passkey sign-in needs JavaScript.</p></noscript>
  <p class="other"><a href="/">Other ways to sign in</a></p>
  <p class="note">This is the break-glass sign-in for when the normal sign-in is unavailable. No passkey yet? Add one under Mail &gt; Settings &gt; Passkeys the next time you can sign in. Lost your passkeys? Ask a manager.</p>
</main>
<script src="/auth/passkey/client.js" defer></script>
</body>
</html>
`;
}

export const PASSKEY_CLIENT_JS = `'use strict';
(function () {
  var button = document.getElementById('passkey-button');
  var status = document.getElementById('passkey-status');
  function say(text, isError) {
    status.textContent = text;
    status.className = isError ? 'error' : '';
  }
  function fromBase64Url(value) {
    var base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  function toBase64Url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  async function postJson(path, body) {
    var response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    });
    var data = {};
    try { data = await response.json(); } catch (ignored) { data = {}; }
    if (!response.ok) throw new Error(typeof data.message === 'string' ? data.message : 'Sign-in failed. Try again.');
    return data;
  }
  if (!window.PublicKeyCredential || !navigator.credentials || !navigator.credentials.get) {
    say('This browser cannot use passkeys. Try another browser or device.', true);
    return;
  }
  button.disabled = false;
  button.addEventListener('click', async function () {
    button.disabled = true;
    say('Waiting for your passkey...', false);
    try {
      var start = await postJson('/auth/passkey/options', {});
      var options = start.options;
      var credential = await navigator.credentials.get({
        publicKey: {
          challenge: fromBase64Url(options.challenge),
          rpId: options.rpId,
          timeout: options.timeout,
          userVerification: options.userVerification,
          allowCredentials: []
        }
      });
      if (!credential) throw new Error('No passkey was chosen.');
      var response = credential.response;
      var finish = await postJson('/auth/passkey/verify', {
        challengeId: start.challengeId,
        response: {
          id: credential.id,
          rawId: toBase64Url(credential.rawId),
          type: credential.type,
          authenticatorAttachment: credential.authenticatorAttachment || undefined,
          clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
          response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            authenticatorData: toBase64Url(response.authenticatorData),
            signature: toBase64Url(response.signature),
            userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined
          }
        }
      });
      say('Signed in. Opening your mail...', false);
      window.location.assign(typeof finish.location === 'string' && finish.location.charAt(0) === '/' && finish.location.charAt(1) !== '/' ? finish.location : '/mail');
    } catch (error) {
      var cancelled = error && (error.name === 'NotAllowedError' || error.name === 'AbortError');
      say(cancelled ? 'Cancelled or timed out. Try again.' : (error && error.message) || 'Sign-in failed. Try again.', true);
      button.disabled = false;
    }
  });
})();
`;
