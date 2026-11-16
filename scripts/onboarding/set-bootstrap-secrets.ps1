#Requires -Version 7.2

<#
.SYNOPSIS
  Sets (or, with -Remove, deletes) the two one-time bootstrap secrets that let
  the first manager sign in to a new cmail instance.

.DESCRIPTION
  Step 4 of docs/onboarding-microsoft-365.md and docs/configuration.md#bootstrap.

  Stores BOOTSTRAP_ADMIN_EMAIL and a fresh BOOTSTRAP_ADMIN_TOKEN (32 random
  bytes, base64url) on the Pages project. You type the token into the form at
  <APP_URL>/bootstrap, never into a URL, so you need it once:
  - default: it is copied to the clipboard and not shown;
  - -TokenOutput Console: it is written to this console once (only on a
    screen nobody else sees, with no transcript or screen recording running).

  Then redeploy the web app, open <APP_URL>/bootstrap, submit the token,
  sign in with Microsoft as AdminEmail and check you are a manager. Straight
  after, run this script again with -Remove and redeploy: /bootstrap then
  redirects and the token is useless.

.PARAMETER PagesProject
  The Cloudflare Pages project name of the web app.
.PARAMETER AdminEmail
  The first manager's sign-in address, exactly as Microsoft returns it (UserInfo email).
.PARAMETER TokenOutput
  Clipboard (default) or Console.
.PARAMETER Remove
  Delete both secrets instead (after a successful bootstrap).
.PARAMETER RepoRoot
  The cmail checkout that has Wrangler installed. Defaults to this repository.

.EXAMPLE
  pwsh -File scripts/onboarding/set-bootstrap-secrets.ps1 -PagesProject cmail-web -AdminEmail admin@example.com
.EXAMPLE
  pwsh -File scripts/onboarding/set-bootstrap-secrets.ps1 -PagesProject cmail-web -Remove
#>
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Set')]
param(
  [Parameter(Mandatory)][string]$PagesProject,
  [Parameter(Mandatory, ParameterSetName = 'Set')][string]$AdminEmail,
  [Parameter(ParameterSetName = 'Set')][ValidateSet('Clipboard', 'Console')][string]$TokenOutput = 'Clipboard',
  [Parameter(Mandatory, ParameterSetName = 'Remove')][switch]$Remove,
  [string]$RepoRoot = ''
)

. (Join-Path $PSScriptRoot '_common.ps1')
if (-not $RepoRoot) { $RepoRoot = Get-RepoRoot }

if ($Remove) {
  Write-Step "Removing bootstrap secrets from $PagesProject"
  foreach ($name in 'BOOTSTRAP_ADMIN_TOKEN', 'BOOTSTRAP_ADMIN_EMAIL') {
    if ($PSCmdlet.ShouldProcess("Pages project $PagesProject", "delete $name")) {
      Remove-WranglerSecret -Name $name -PagesProject $PagesProject -RepoRoot $RepoRoot
    }
  }
  Write-Step 'Next'
  Write-Note 'Redeploy the web app (pnpm deploy:web), then check <APP_URL>/bootstrap redirects away.'
  return
}

if ($AdminEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'AdminEmail must be an email address.' }
if ($TokenOutput -eq 'Clipboard' -and -not $WhatIfPreference -and -not (Get-Command Set-Clipboard -ErrorAction SilentlyContinue)) {
  throw 'No clipboard on this system. Run again with -TokenOutput Console.'
}

Write-Step "Bootstrap secrets for $PagesProject"
if ($PSCmdlet.ShouldProcess("Pages project $PagesProject", 'store BOOTSTRAP_ADMIN_EMAIL')) {
  Set-WranglerSecret -Name BOOTSTRAP_ADMIN_EMAIL -Value $AdminEmail -PagesProject $PagesProject -RepoRoot $RepoRoot
}
if ($PSCmdlet.ShouldProcess("Pages project $PagesProject", 'generate and store BOOTSTRAP_ADMIN_TOKEN')) {
  $token = New-RandomToken 32
  try {
    Set-WranglerSecret -Name BOOTSTRAP_ADMIN_TOKEN -Value $token -PagesProject $PagesProject -RepoRoot $RepoRoot
    if ($TokenOutput -eq 'Clipboard') {
      Set-Clipboard -Value $token
      Write-Note 'The token is on your clipboard. Paste it into the /bootstrap form only. Clipboard history (Windows Win+V, or a clipboard manager) may keep a copy: delete it there if history is on.'
    } else {
      Write-Warning 'Showing the one-time token once. Do not paste it into a URL, chat or ticket.'
      [Console]::Out.WriteLine($token)
    }
  } finally { Remove-Variable token -ErrorAction SilentlyContinue }
}

Write-Step 'Next'
Write-Note '1. Redeploy the web app (pnpm deploy:web).'
Write-Note '2. Open <APP_URL>/bootstrap, submit the token, sign in with Microsoft as the admin address, check you are a manager.'
Write-Note "3. Run: pwsh -File scripts/onboarding/set-bootstrap-secrets.ps1 -PagesProject $PagesProject -Remove ; then redeploy again."
