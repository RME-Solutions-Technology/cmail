#Requires -Version 7.2

<#
.SYNOPSIS
  Creates (or reuses) the read-only Entra app for the Microsoft 365 mailbox
  sync, grants admin consent, and stores a new client secret on the email Worker.

.DESCRIPTION
  Step 5 of docs/onboarding-microsoft-365.md; the feature is docs/m365-sync.md.

  Microsoft Graph application permissions, nothing else:
  - User.Read.All (always);
  - MailboxSettings.Read with -DetectSharedMailboxes;
  - GroupMember.Read.All with -GroupScoped (M365_SCOPE_GROUP_ID or M365_SHARED_GROUP_ID).
  Permission ids are looked up from Microsoft Graph's service principal in the
  tenant, not hard-coded. Admin consent is granted with
  `az ad app permission admin-consent` and then checked on the service
  principal's appRoleAssignments.

  The client secret is piped from `az ad app credential reset --append`
  straight into `wrangler secret put M365_CLIENT_SECRET`: never printed,
  never an argument, never a file.

  Needs: Azure CLI signed in to the tenant as a Privileged Role Administrator
  or Global Administrator (admin consent for application permissions), pnpm
  install done in the repo, Wrangler signed in to the Cloudflare account.

  Undo: Admin > Microsoft 365 sync > off; `wrangler secret delete
  M365_CLIENT_SECRET --config <WranglerConfig>`; az ad app delete --id <app id>.

.PARAMETER TenantId
  Directory (tenant) ID, a GUID.
.PARAMETER MailDomain
  The cmail MAIL_DOMAIN (example.com). Only shown in the settings to copy; the sync only touches users on it.
.PARAMETER WranglerConfig
  Path to the email Worker's wrangler.toml (the instance's own, not the example).
.PARAMETER DisplayName
  Name of the Entra app. Reused if exactly one app has this name.
.PARAMETER AppId
  Use this existing app instead of finding or creating one by name.
.PARAMETER DetectSharedMailboxes
  Add MailboxSettings.Read so the sync can tell shared mailboxes from people (M365_DETECT_SHARED_MAILBOXES).
.PARAMETER GroupScoped
  Add GroupMember.Read.All, needed only for M365_SCOPE_GROUP_ID or M365_SHARED_GROUP_ID.
.PARAMETER SecretMonths
  Months until the client secret expires (1 to 24).
.PARAMETER ConsentWaitSeconds
  How long to wait for admin consent to show on the service principal.
.PARAMETER SkipSecret
  Create and consent the app only; store nothing on Cloudflare.
.PARAMETER RepoRoot
  The cmail checkout that has Wrangler installed. Defaults to this repository.

.EXAMPLE
  pwsh -File scripts/onboarding/new-sync-app.ps1 -TenantId 00000000-0000-0000-0000-000000000000 -MailDomain example.com -WranglerConfig apps/email-worker/wrangler.toml -DetectSharedMailboxes -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$TenantId,
  [Parameter(Mandatory)][string]$MailDomain,
  [Parameter(Mandatory)][string]$WranglerConfig,
  [string]$DisplayName = 'cmail directory sync (read-only)',
  [string]$AppId = '',
  [switch]$DetectSharedMailboxes,
  [switch]$GroupScoped,
  [ValidateRange(1, 24)][int]$SecretMonths = 12,
  [ValidateRange(0, 600)][int]$ConsentWaitSeconds = 120,
  [switch]$SkipSecret,
  [string]$RepoRoot = ''
)

. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Guid $TenantId 'TenantId'
Assert-DomainName $MailDomain 'MailDomain'
if ($AppId) { Assert-Guid $AppId 'AppId' }
if (-not $RepoRoot) { $RepoRoot = Get-RepoRoot }
$dryRun = [bool]$WhatIfPreference
if (-not $dryRun) { $WranglerConfig = Resolve-WranglerConfig $WranglerConfig }

$permissions = @('User.Read.All')
if ($DetectSharedMailboxes) { $permissions += 'MailboxSettings.Read' }
if ($GroupScoped) { $permissions += 'GroupMember.Read.All' }

Write-Step "Microsoft 365 sync app ($($permissions -join ', '))"
if ($dryRun) {
  Write-Note 'Dry run: nothing is read from or written to Entra or Cloudflare.'
  $roleIds = @()
} else {
  Assert-AzTenant $TenantId
  $roleIds = @(foreach ($p in $permissions) { Get-ResourcePermissionId -ResourceAppId $script:GraphResourceAppId -Value $p -Kind Role })
  if (-not $AppId) { $AppId = Find-EntraApp $DisplayName }
}

if (-not $AppId) {
  if ($PSCmdlet.ShouldProcess("Entra app '$DisplayName'", "create: single tenant, no redirect URI, Graph application permissions $($permissions -join ', ')")) {
    $rraFile = New-ResourceAccessFile -ResourceAppId $script:GraphResourceAppId -PermissionIds $roleIds -Kind Role
    try {
      $AppId = Get-FirstLine (Invoke-Az ad app create --display-name $DisplayName --sign-in-audience AzureADMyOrg --required-resource-accesses "@$rraFile" --query appId -o tsv)
    } finally { Remove-Item -LiteralPath $rraFile -Force -ErrorAction SilentlyContinue }
    Assert-Guid $AppId 'New app id'
    Write-Note "Created app $AppId."
  }
} elseif (-not $dryRun) {
  Write-Note "Using existing app $AppId."
  $have = @(Invoke-Az ad app show --id $AppId --query "requiredResourceAccess[?resourceAppId=='$($script:GraphResourceAppId)'].resourceAccess[].id" -o tsv |
    Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() })
  foreach ($i in 0..($permissions.Count - 1)) {
    if ($have -notcontains $roleIds[$i] -and $PSCmdlet.ShouldProcess("Entra app $AppId", "add Graph application permission $($permissions[$i])")) {
      Invoke-Az ad app permission add --id $AppId --api $script:GraphResourceAppId --api-permissions "$($roleIds[$i])=Role" | Out-Null
    }
  }
}
if (-not $AppId) {
  if (-not $dryRun) { Write-Warning 'No app was created; nothing else done.'; return }
  $AppId = '<new app id>'
}

if ($PSCmdlet.ShouldProcess("Entra app $AppId", 'create service principal and grant admin consent')) {
  $spId = Get-FirstLine (Invoke-Az ad sp list --filter "appId eq '$AppId'" --query '[].id' -o tsv)
  if (-not $spId) { $spId = Get-FirstLine (Invoke-Az ad sp create --id $AppId --query id -o tsv) }
  Assert-Guid $spId 'Service principal id'
  # A new service principal can take a few seconds to be visible to consent.
  $tries = 0
  while ($true) {
    try { Invoke-Az ad app permission admin-consent --id $AppId | Out-Null; break }
    catch { if (++$tries -ge 4) { throw }; Start-Sleep -Seconds 15 }
  }
  Wait-AppRoleAssignments -ServicePrincipalId $spId -ExpectedRoleIds $roleIds -WaitSeconds $ConsentWaitSeconds
  Write-Note "Admin consent granted and visible for: $($permissions -join ', ')."
}

if (-not $SkipSecret -and $PSCmdlet.ShouldProcess("Entra app $AppId -> Worker ($WranglerConfig)", "create a $SecretMonths-month client secret and store it as M365_CLIENT_SECRET")) {
  $endDate = (Get-Date).ToUniversalTime().AddMonths($SecretMonths).ToString('yyyy-MM-dd')
  $secret = Get-FirstLine (Invoke-Az ad app credential reset --id $AppId --append --display-name "cmail sync $(Get-Date -Format yyyy-MM-dd)" --end-date $endDate --query password -o tsv)
  try {
    Set-WranglerSecret -Name M365_CLIENT_SECRET -Value $secret -WranglerConfig $WranglerConfig -RepoRoot $RepoRoot
  } finally { Remove-Variable secret -ErrorAction SilentlyContinue }
  Write-Note "Client secret expires $endDate. Record it in your secrets register and rotate before then."
}

Write-Step 'Next: email Worker wrangler.toml [vars], then deploy the Worker'
Write-Note "M365_TENANT_ID = `"$TenantId`""
Write-Note "M365_CLIENT_ID = `"$AppId`""
Write-Note "MAIL_DOMAIN = `"$MailDomain`""
Write-Note ("M365_DETECT_SHARED_MAILBOXES = `"{0}`"" -f $(if ($DetectSharedMailboxes) { 'true' } else { 'false' }))
Write-Note 'Keep "*/15 * * * *" in [triggers] crons. Then Admin > Microsoft 365 sync: on, dry run on, Sync now.'
