#Requires -Version 7.2

<#
.SYNOPSIS
  Creates (or reuses) the Entra app staff use to sign in to cmail, and stores
  its client id and a new client secret on the cmail Pages project.

.DESCRIPTION
  Step 3 of docs/onboarding-microsoft-365.md.

  The app is single tenant, has one Web redirect URI
  (<AppUrl>/auth/callback/microsoft) and asks only for the delegated OpenID
  Connect scopes openid, email and profile. The client secret is created with
  `az ad app credential reset --append` and piped straight into
  `wrangler pages secret put MICROSOFT_CLIENT_SECRET`: it is never printed,
  never passed as an argument and never written to a file.

  Needs: Azure CLI signed in to the tenant (`az login --tenant <id>
  --allow-no-subscriptions`) with an active Application Administrator, Cloud
  Application Administrator or Global Administrator role (checked first;
  activate PIM roles, then `az login` again),
  Node + pnpm with `pnpm install` done in the repo, and Wrangler signed in to
  the Cloudflare account that holds the Pages project.

  Afterwards set MICROSOFT_TENANT_ID = "<TenantId>" in the web app's
  wrangler.toml [vars] and redeploy the web app; the secrets take effect on
  the next deployment.

  Undo: az ad app delete --id <app id>, then
  `wrangler pages secret delete MICROSOFT_CLIENT_ID --env=""` / `MICROSOFT_CLIENT_SECRET`
  and redeploy.

.PARAMETER TenantId
  Directory (tenant) ID, a GUID. The script stops if az is signed in to another tenant.
.PARAMETER AppUrl
  The web app's final https origin, for example https://mail.example.com (no trailing slash).
.PARAMETER PagesProject
  The Cloudflare Pages project name of the web app.
.PARAMETER DisplayName
  Name of the Entra app. Reused if exactly one app has this name.
.PARAMETER AppId
  Use this existing app instead of finding or creating one by name.
.PARAMETER SecretMonths
  Months until the new client secret expires (1 to 24). Record the date and rotate before it.
.PARAMETER GrantAdminConsent
  Also grant tenant-wide admin consent for openid, email and profile, so staff
  never see a consent prompt (needed when user consent is turned off in the tenant).
.PARAMETER SkipSecret
  Create or check the app only; store nothing on Cloudflare.
.PARAMETER RepoRoot
  The cmail checkout that has Wrangler installed. Defaults to this repository.

.EXAMPLE
  pwsh -File scripts/onboarding/new-signin-app.ps1 -TenantId 00000000-0000-0000-0000-000000000000 -AppUrl https://mail.example.com -PagesProject cmail-web -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$TenantId,
  [Parameter(Mandatory)][string]$AppUrl,
  [Parameter(Mandatory)][string]$PagesProject,
  [string]$DisplayName = 'cmail',
  [string]$AppId = '',
  [ValidateRange(1, 24)][int]$SecretMonths = 12,
  [switch]$GrantAdminConsent,
  [switch]$SkipSecret,
  [string]$RepoRoot = ''
)

. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Guid $TenantId 'TenantId'
Assert-HttpsOrigin $AppUrl 'AppUrl'
if ($AppId) { Assert-Guid $AppId 'AppId' }
if (-not $RepoRoot) { $RepoRoot = Get-RepoRoot }
$redirectUri = "$AppUrl/auth/callback/microsoft"
$dryRun = [bool]$WhatIfPreference

Write-Step "Sign-in app for $AppUrl"
if ($dryRun) {
  Write-Note 'Dry run: nothing is read from or written to Entra or Cloudflare.'
} else {
  Assert-AzTenant $TenantId
  Assert-AdminRoles -Need AppRegistration
  if (-not $AppId) { $AppId = Find-EntraApp $DisplayName }
}

if (-not $AppId) {
  if ($PSCmdlet.ShouldProcess("Entra app '$DisplayName'", "create: single tenant, redirect $redirectUri, delegated openid email profile")) {
    $scopeIds = foreach ($scope in 'openid', 'email', 'profile') { Get-ResourcePermissionId -ResourceAppId $script:GraphResourceAppId -Value $scope -Kind Scope }
    $rraFile = New-ResourceAccessFile -ResourceAppId $script:GraphResourceAppId -PermissionIds $scopeIds -Kind Scope
    try {
      $AppId = Get-FirstLine (Invoke-Az ad app create --display-name $DisplayName --sign-in-audience AzureADMyOrg --web-redirect-uris $redirectUri --required-resource-accesses "@$rraFile" --query appId -o tsv)
    } finally { Remove-Item -LiteralPath $rraFile -Force -ErrorAction SilentlyContinue }
    Assert-Guid $AppId 'New app id'
    Write-Note "Created app $AppId."
  }
} elseif (-not $dryRun) {
  Write-Note "Using existing app $AppId."
  $uris = @(Invoke-Az ad app show --id $AppId --query 'web.redirectUris' -o tsv | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() })
  if ($uris -notcontains $redirectUri) {
    if ($PSCmdlet.ShouldProcess("Entra app $AppId", "add Web redirect URI $redirectUri")) {
      Invoke-Az ad app update --id $AppId --web-redirect-uris @uris $redirectUri | Out-Null
    }
  }
  $audience = Get-FirstLine (Invoke-Az ad app show --id $AppId --query signInAudience -o tsv)
  if ($audience -ne 'AzureADMyOrg') { Write-Warning "App $AppId is '$audience', not single tenant. cmail expects a single-tenant app for this guide." }
}

if (-not $AppId) {
  if (-not $dryRun) { Write-Warning 'No app was created; nothing else done.'; return }
  $AppId = '<new app id>'
}

if ($GrantAdminConsent -and $PSCmdlet.ShouldProcess("Entra app $AppId", 'create service principal and grant tenant-wide admin consent for openid email profile')) {
  if (-not (Invoke-Az ad sp list --filter "appId eq '$AppId'" --query '[].id' -o tsv)) { Invoke-Az ad sp create --id $AppId | Out-Null }
  Invoke-Az ad app permission admin-consent --id $AppId | Out-Null
  Write-Note 'Admin consent granted.'
}

if (-not $SkipSecret) {
  if ($PSCmdlet.ShouldProcess("Pages project $PagesProject", 'store MICROSOFT_CLIENT_ID')) {
    Set-WranglerSecret -Name MICROSOFT_CLIENT_ID -Value $AppId -PagesProject $PagesProject -RepoRoot $RepoRoot
  }
  if ($PSCmdlet.ShouldProcess("Entra app $AppId -> Pages project $PagesProject", "create a $SecretMonths-month client secret and store it as MICROSOFT_CLIENT_SECRET")) {
    $endDate = (Get-Date).ToUniversalTime().AddMonths($SecretMonths).ToString('yyyy-MM-dd')
    $secret = Get-FirstLine (Invoke-Az ad app credential reset --id $AppId --append --display-name "cmail web $(Get-Date -Format yyyy-MM-dd)" --end-date $endDate --query password -o tsv)
    try {
      Set-WranglerSecret -Name MICROSOFT_CLIENT_SECRET -Value $secret -PagesProject $PagesProject -RepoRoot $RepoRoot
    } finally { Remove-Variable secret -ErrorAction SilentlyContinue }
    Write-Note "Client secret expires $endDate. Record it in your secrets register and rotate before then."
  }
}

Write-Step 'Next'
Write-Note "1. In apps/web/wrangler.toml [vars]: MICROSOFT_TENANT_ID = `"$TenantId`" and APP_URL = `"$AppUrl`"."
Write-Note '2. Redeploy the web app (pnpm deploy:web). The Microsoft button appears once the deployment has the secrets.'
