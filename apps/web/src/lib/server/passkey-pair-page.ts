// The phone side of "Add a phone" (/auth/passkey/pair), one self-contained
// HTML response plus one script, like the sign-in page (passkey-signin-page.ts):
// it needs nothing outside /auth/passkey, so one Cloudflare Access Bypass for
// /auth/passkey/* covers it.
//
// The pairing token arrives in the URL fragment, which browsers never send to
// a server. The script reads it, removes it from the address bar, and posts it
// to /auth/passkey/pair/join. All checking is on the server (passkey-pairing.ts).
import { escapeHtml } from './validation';

export function renderPasskeyPairPage(options: { appName: string; orgName: string }): string {
  const appName = escapeHtml(options.appName || 'cmail');
  const orgName = escapeHtml(options.orgName || '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Add this phone · ${appName}</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --text: #1b1b1f; --muted: #5d5f66; --primary: #0f6cbd; --on-primary: #ffffff; --danger: #b3261e; --border: #d0d3da; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16171a; --text: #ececf1; --muted: #a9acb5; --primary: #4ea1f3; --on-primary: #0b1220; --danger: #ff8a80; --border: #3a3d45; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  main { width: 100%; max-width: 420px; text-align: center; }
  h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
  p { margin: 0 0 18px; color: var(--muted); }
  button { width: 100%; min-height: 44px; padding: 10px 14px; border: 0; border-radius: 6px; background: var(--primary); color: var(--on-primary); font: inherit; font-weight: 600; cursor: pointer; }
  button[hidden] { display: none; }
  button:disabled { opacity: .6; cursor: progress; }
  button:focus-visible, a:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  #pair-status { min-height: 1.5em; margin: 14px 0 0; color: var(--text); }
  #pair-status.error { color: var(--danger); }
  a { color: var(--primary); }
  .note { margin-top: 28px; font-size: 12px; text-align: left; border-top: 1px solid var(--border); padding-top: 12px; }
</style>
</head>
<body>
<main id="main-content">
  <h1>Add this phone</h1>
  <p>${orgName ? `${orgName} · ` : ''}${appName}. This creates a passkey on this phone for your account. You will confirm with your fingerprint, face or PIN.</p>
  <button type="button" id="pair-button" hidden>Create passkey</button>
  <div id="pair-status" role="status" aria-live="polite"></div>
  <noscript><p>Adding a phone needs JavaScript. Turn it on and scan the code again.</p></noscript>
  <p class="note">Scanned a code you did not start? Close this page. Nothing is added unless the person signed in on the computer approves this phone, and a code stops working after 10 minutes.</p>
</main>
<script src="/auth/passkey/pair/client.js" defer></script>
</body>
</html>
`;
}

export const PASSKEY_PAIR_CLIENT_JS = `'use strict';
(function () {
  var button = document.getElementById('pair-button');
  var status = document.getElementById('pair-status');
  var token = '';
  var joiner = '';
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
      credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    });
    var data = {};
    try { data = await response.json(); } catch (ignored) { data = {}; }
    if (!response.ok) {
      var error = new Error(typeof data.message === 'string' ? data.message : 'That did not work. Try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  token = (window.location.hash || '').replace(/^#/, '');
  // The token never stays in the address bar or history.
  try { history.replaceState(null, '', window.location.pathname); } catch (ignored) { /* ignore */ }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    say('This link is not complete. Scan the code on your computer again.', true);
    return;
  }
  if (!window.PublicKeyCredential || !navigator.credentials || !navigator.credentials.create) {
    say('This browser cannot create passkeys. Try another browser on this phone.', true);
    return;
  }

  async function waitForApproval() {
    for (;;) {
      var state = await postJson('/auth/passkey/pair/options', { token: token, joiner: joiner, wait: true });
      if (state.state === 'approved') return;
      if (state.state === 'denied') throw new Error('The request was declined on your computer.');
      if (state.state === 'expired' || state.state === 'consumed') throw new Error('This code has expired. Start again on your computer.');
      await sleep(2000);
    }
  }

  async function run() {
    say('Connecting...', false);
    try {
      var joined = await postJson('/auth/passkey/pair/join', { token: token });
      joiner = joined.joiner;
      say('Waiting for approval on your computer. It will ask you to approve "' + (joined.deviceLabel || 'this phone') + '".', false);
      await waitForApproval();
      say('Approved. Press Create passkey.', false);
      button.hidden = false;
      button.disabled = false;
      button.focus();
    } catch (error) {
      say((error && error.message) || 'That did not work. Try again.', true);
    }
  }

  button.addEventListener('click', async function () {
    button.disabled = true;
    say('Follow the prompt on this phone...', false);
    try {
      var start = await postJson('/auth/passkey/pair/options', { token: token, joiner: joiner });
      var options = start.options;
      var credential;
      try {
        credential = await navigator.credentials.create({
          publicKey: {
            rp: options.rp,
            user: { id: fromBase64Url(options.user.id), name: options.user.name, displayName: options.user.displayName },
            challenge: fromBase64Url(options.challenge),
            pubKeyCredParams: options.pubKeyCredParams,
            timeout: options.timeout,
            excludeCredentials: (options.excludeCredentials || []).map(function (item) {
              return { id: fromBase64Url(item.id), type: 'public-key', transports: item.transports };
            }),
            authenticatorSelection: options.authenticatorSelection,
            attestation: options.attestation
          }
        });
      } catch (createError) {
        var name = createError && createError.name;
        if (name === 'InvalidStateError') throw new Error('This phone already has a passkey for your account.');
        if (name === 'NotAllowedError' || name === 'AbortError') throw new Error('Cancelled or timed out. Press Create passkey to try again.');
        throw new Error('This phone could not create a passkey.');
      }
      if (!credential) throw new Error('No passkey was created.');
      var response = credential.response;
      await postJson('/auth/passkey/pair/verify', {
        token: token,
        joiner: joiner,
        challengeId: start.challengeId,
        response: {
          id: credential.id,
          rawId: toBase64Url(credential.rawId),
          type: credential.type,
          authenticatorAttachment: credential.authenticatorAttachment || undefined,
          clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
          response: {
            clientDataJSON: toBase64Url(response.clientDataJSON),
            attestationObject: toBase64Url(response.attestationObject),
            transports: typeof response.getTransports === 'function' ? response.getTransports() : []
          }
        }
      });
      button.hidden = true;
      say('Done. Next time use Sign in with a passkey. You can also add this site to your home screen.', false);
    } catch (error) {
      say((error && error.message) || 'That did not work. Try again.', true);
      // Keep the button while the code still lasts; an ended code says so.
      button.disabled = !(error && (error.status === undefined || error.status === 400 || error.status === 409));
    }
  });

  run();
})();
`;
