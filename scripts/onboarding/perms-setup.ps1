#Requires -Version 7.2

<#
.SYNOPSIS
  One-time tenant setup for cmail's shared mailbox access sync (read-only
  toward Exchange): Entra app with Exchange.ManageAsApp, a certificate, a
  read-only custom Exchange role in its own role group, the go/no-go check,
  and the certificate stored as email Worker secrets. -Rollback undoes it.

.DESCRIPTION
  Step 11 of docs/onboarding-microsoft-365.md; the feature is
  docs/m365-mailbox-permissions.md (steps 1 to 5 there).

  What it does, in order, stopping at the first error:
  1. Entra app (single tenant, no redirect URI) with the Office 365 Exchange
     Online application permission Exchange.ManageAsApp, admin consent,
     checked on the service principal.
  2. A self-signed certificate with a CSP key (-KeySpec KeyExchange; the
     Exchange module does not support CNG keys here), exportable, valid
     -CertMonths. The public part is uploaded to the app. The PFX exists on
     disk only between export and upload to the Worker, in -WorkDir, and is
     deleted in all cases. Windows only (New-SelfSignedCertificate).
  3. Exchange (delegated sign-in as an admin): organisation customisation if
     needed, a custom role from "Mail Recipients" trimmed to exactly six read
     cmdlets, a role group holding only that role, the app's Exchange service
     principal as its member. Stops (no-go) if a cmdlet is missing.
  4. Go / no-go as the app: a write (Add-MailboxPermission -WhatIf) must fail,
     and a shared mailbox's grants must be readable. No-go stores nothing.
  5. GO: the PFX (base64) and its random password are piped into the email
     Worker secrets M365_EXO_CERT_PFX_B64 and M365_EXO_CERT_PASSWORD. Never
     printed, never an argument.

  Then: [vars] M365_EXO_APP_ID and M365_EXO_ORGANIZATION, the container block
  in wrangler.toml, Docker running on the deploying machine, migration 0028,
  deploy, and Admin > Shared mailbox access in dry run.

.PARAMETER TenantId
  Directory (tenant) ID, a GUID.
.PARAMETER Organization
  The tenant's initial domain, <name>.onmicrosoft.com (used for app-only sign-in).
.PARAMETER WranglerConfig
  The email Worker's wrangler.toml (the instance's own).
.PARAMETER AppName
  Entra app display name; also the certificate subject.
.PARAMETER RoleName
  Custom Exchange management role name.
.PARAMETER RoleGroupName
  Exchange role group name.
.PARAMETER CertMonths
  Certificate lifetime in months (1 to 24). Renew before it ends.
.PARAMETER WorkDir
  Folder for the temporary .cer and .pfx files. Default: a new folder under the system temp directory.
.PARAMETER UserPrincipalName
  Optional admin sign-in name for the delegated Exchange connection.
.PARAMETER ExchangeModuleVersion
  ExchangeOnlineManagement version; the collector image pins 3.11.1.
.PARAMETER PropagationWaitSeconds
  Wait after the Exchange changes before the go/no-go check (Exchange RBAC takes time to apply).
.PARAMETER Rollback
  Remove the role group, the role, the Exchange service principal, the Entra
  app and the local certificate. Worker secrets are left (harmless with the
  feature off; delete them with wrangler secret delete if you want).
.PARAMETER RepoRoot
  The cmail checkout that has Wrangler installed. Defaults to this repository.

.EXAMPLE
  pwsh -File scripts/onboarding/perms-setup.ps1 -TenantId 00000000-0000-0000-0000-000000000000 -Organization example.onmicrosoft.com -WranglerConfig apps/email-worker/wrangler.toml -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$TenantId,
  [Parameter(Mandatory)][string]$Organization,
  [Parameter(Mandatory)][string]$WranglerConfig,
  [string]$AppName = 'cmail Exchange permission reader',
  [string]$RoleName = 'cmail Mailbox Access Reader (Mail Recipients)',
  [string]$RoleGroupName = 'cmail Mailbox Access Readers',
  [ValidateRange(1, 24)][int]$CertMonths = 12,
  [string]$WorkDir = '',
  [string]$UserPrincipalName = '',
  [string]$ExchangeModuleVersion = '3.11.1',
  [ValidateRange(0, 600)][int]$PropagationWaitSeconds = 60,
  [switch]$Rollback,
  [string]$RepoRoot = ''
)

. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Guid $TenantId 'TenantId'
if ($Organization -notmatch '^[a-z0-9-]+\.onmicrosoft\.com$') { throw 'Organization must be the tenant''s <name>.onmicrosoft.com domain.' }
if (-not $RepoRoot) { $RepoRoot = Get-RepoRoot }
if (-not $WorkDir) { $WorkDir = Join-Path ([IO.Path]::GetTempPath()) ("cmail-perms-{0}" -f [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$dryRun = [bool]$WhatIfPreference
$readCmdlets = 'Get-Mailbox', 'Get-MailboxPermission', 'Get-RecipientPermission', 'Get-Recipient', 'Get-User', 'Get-Group'

function Connect-ExoAdmin {
  $connect = @{ ShowBanner = $false }
  if ($UserPrincipalName) { $connect.UserPrincipalName = $UserPrincipalName }
  Connect-ExchangeOnline @connect
}

if ($dryRun) {
  Write-Note 'Dry run: no sign-in to Entra, Exchange or Cloudflare; showing what would change.'
} else {
  Assert-AzTenant $TenantId
  Import-ExchangeModule $ExchangeModuleVersion
  $WranglerConfig = Resolve-WranglerConfig $WranglerConfig
}

# ---- Rollback -------------------------------------------------------------
if ($Rollback) {
  Write-Step 'Rolling back the shared mailbox access setup'
  $appId = if ($dryRun) { '<app id>' } else { Find-EntraApp $AppName }
  if (-not $dryRun) { Connect-ExoAdmin }
  try {
    if ($PSCmdlet.ShouldProcess("role group '$RoleGroupName'", 'remove')) {
      if (Get-RoleGroup -Identity $RoleGroupName -ErrorAction SilentlyContinue) { Remove-RoleGroup -Identity $RoleGroupName -Confirm:$false }
    }
    if ($PSCmdlet.ShouldProcess("management role '$RoleName'", 'remove')) {
      if (Get-ManagementRole -Identity $RoleName -ErrorAction SilentlyContinue) { Remove-ManagementRole -Identity $RoleName -Confirm:$false }
    }
    if ($appId -and $PSCmdlet.ShouldProcess("Exchange service principal for $appId", 'remove')) {
      if (Get-ServicePrincipal -Identity $appId -ErrorAction SilentlyContinue) { Remove-ServicePrincipal -Identity $appId -Confirm:$false }
    }
  } finally { if (-not $dryRun) { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue } }
  if ($appId -and $PSCmdlet.ShouldProcess("Entra app $appId", 'delete')) { Invoke-Az ad app delete --id $appId | Out-Null }
  if ($PSCmdlet.ShouldProcess("certificate CN=$AppName in CurrentUser\My", 'remove')) {
    if (Test-Path 'Cert:\CurrentUser\My') {
      Get-ChildItem 'Cert:\CurrentUser\My' | Where-Object Subject -EQ "CN=$AppName" | Remove-Item -Force
    }
  }
  Write-Step 'Rolled back. Turn the feature off in Admin first if it was on; Worker secrets were left in place.'
  return
}

# ---- 1. Entra app ---------------------------------------------------------
Write-Step "1. Entra app '$AppName' with Exchange.ManageAsApp"
$appId = if ($dryRun) { '' } else { Find-EntraApp $AppName }
if (-not $appId) {
  if ($PSCmdlet.ShouldProcess("Entra app '$AppName'", 'create: single tenant, Office 365 Exchange Online application permission Exchange.ManageAsApp')) {
    $roleId = Get-ResourcePermissionId -ResourceAppId $script:ExchangeResourceAppId -Value 'Exchange.ManageAsApp' -Kind Role
    $rraFile = New-ResourceAccessFile -ResourceAppId $script:ExchangeResourceAppId -PermissionIds @($roleId) -Kind Role
    try {
      $appId = Get-FirstLine (Invoke-Az ad app create --display-name $AppName --sign-in-audience AzureADMyOrg --required-resource-accesses "@$rraFile" --query appId -o tsv)
    } finally { Remove-Item -LiteralPath $rraFile -Force -ErrorAction SilentlyContinue }
    Assert-Guid $appId 'New app id'
    Write-Note "Created app $appId."
  }
} else { Write-Note "Using existing app $appId." }
if (-not $appId) {
  if (-not $dryRun) { Write-Warning 'No app was created; nothing else done.'; return }
  $appId = '<new app id>'
}
$spObjectId = '<service principal object id>'
if ($PSCmdlet.ShouldProcess("Entra app $appId", 'create service principal and grant admin consent')) {
  $roleId = Get-ResourcePermissionId -ResourceAppId $script:ExchangeResourceAppId -Value 'Exchange.ManageAsApp' -Kind Role
  $spObjectId = Get-FirstLine (Invoke-Az ad sp list --filter "appId eq '$appId'" --query '[].id' -o tsv)
  if (-not $spObjectId) { $spObjectId = Get-FirstLine (Invoke-Az ad sp create --id $appId --query id -o tsv) }
  Assert-Guid $spObjectId 'Service principal object id'
  $tries = 0
  while ($true) {
    try { Invoke-Az ad app permission admin-consent --id $appId | Out-Null; break }
    catch { if (++$tries -ge 4) { throw }; Start-Sleep -Seconds 15 }
  }
  Wait-AppRoleAssignments -ServicePrincipalId $spObjectId -ExpectedRoleIds @($roleId) -WaitSeconds 120
  Write-Note 'Admin consent granted and visible.'
}

# ---- 2. Certificate -------------------------------------------------------
Write-Step '2. Certificate (CSP key, exportable)'
$cert = $null
if ($PSCmdlet.ShouldProcess("Entra app $appId", "create a $CertMonths-month self-signed certificate and upload its public part")) {
  if (-not (Get-Command New-SelfSignedCertificate -ErrorAction SilentlyContinue)) {
    throw 'New-SelfSignedCertificate is not available: run this step on Windows (docs/m365-mailbox-permissions.md, step 2).'
  }
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  $cert = New-SelfSignedCertificate -Subject "CN=$AppName" -CertStoreLocation 'Cert:\CurrentUser\My' -KeySpec KeyExchange `
    -KeyExportPolicy Exportable -NotAfter (Get-Date).AddMonths($CertMonths)
  $cerFile = Join-Path $WorkDir 'cmail-exo-reader.cer'
  Export-Certificate -Cert $cert -FilePath $cerFile | Out-Null
  Invoke-Az ad app credential reset --id $appId --cert "@$cerFile" --append | Out-Null
  Remove-Item -LiteralPath $cerFile -Force
  Write-Note "Certificate $($cert.Thumbprint) expires $($cert.NotAfter.ToString('yyyy-MM-dd')). Record it and renew before then."
}

# ---- 3. Exchange role, role group, service principal ----------------------
Write-Step '3. Exchange: read-only role, role group, service principal'
if ($PSCmdlet.ShouldProcess('Exchange Online', "custom role '$RoleName' ($($readCmdlets -join ', ')), role group '$RoleGroupName', service principal for $appId")) {
  Connect-ExoAdmin
  try {
    if ((Get-OrganizationConfig).IsDehydrated) { Enable-OrganizationCustomization }
    if (-not (Get-ManagementRole -Identity $RoleName -ErrorAction SilentlyContinue)) {
      New-ManagementRole -Name $RoleName -Parent 'Mail Recipients' | Out-Null
      Get-ManagementRoleEntry "$RoleName\*" | Where-Object { $readCmdlets -notcontains $_.Name } |
        ForEach-Object { Remove-ManagementRoleEntry -Identity "$RoleName\$($_.Name)" -Confirm:$false }
    }
    $have = @((Get-ManagementRoleEntry "$RoleName\*").Name | Sort-Object)
    $missing = @($readCmdlets | Where-Object { $have -notcontains $_ })
    $extra = @($have | Where-Object { $readCmdlets -notcontains $_ })
    Write-Note "Role holds: $($have -join ', ')"
    if ($missing.Count -or $extra.Count) {
      throw "NO-GO: the role must hold exactly the six read cmdlets (missing: $($missing -join ', '); extra: $($extra -join ', ')). Fix by hand (docs/m365-mailbox-permissions.md step 3) or run -Rollback."
    }
    if (-not (Get-RoleGroup -Identity $RoleGroupName -ErrorAction SilentlyContinue)) {
      New-RoleGroup -Name $RoleGroupName -Roles $RoleName -Description 'Read-only: Full Access and Send As on shared mailboxes for cmail' | Out-Null
    }
    if (-not (Get-ServicePrincipal -Identity $appId -ErrorAction SilentlyContinue)) {
      New-ServicePrincipal -AppId $appId -ObjectId $spObjectId -DisplayName $AppName | Out-Null
    }
    try { Add-RoleGroupMember -Identity $RoleGroupName -Member $spObjectId -ErrorAction Stop }
    catch { if ("$_" -notmatch 'already a member') { throw } }
  } finally { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }
  if ($PropagationWaitSeconds -gt 0) { Write-Note "Waiting $PropagationWaitSeconds s for Exchange permissions to apply..."; Start-Sleep -Seconds $PropagationWaitSeconds }
}

# ---- 4. Go / no-go, as the app ---------------------------------------------
Write-Step '4. Go / no-go as the app'
$go = $false
if ($PSCmdlet.ShouldProcess("Exchange Online as app $appId", 'check a write fails and a shared mailbox''s grants are readable')) {
  Connect-ExchangeOnline -Certificate $cert -AppId $appId -Organization $Organization -ShowBanner:$false
  try {
    $shared = Get-EXOMailbox -RecipientTypeDetails SharedMailbox -ResultSize 1
    if (-not $shared) { throw 'NO-GO undetermined: the tenant has no shared mailbox to test with. Create one, then run again.' }
    $canWrite = $true
    try {
      Add-MailboxPermission -Identity $shared.PrimarySmtpAddress -User 'nobody@example.test' -AccessRights FullAccess -WhatIf -ErrorAction Stop | Out-Null
    } catch { $canWrite = $false }
    $grants = @(Get-EXOMailboxPermission -Identity $shared.PrimarySmtpAddress -ErrorAction Stop |
      Where-Object { -not $_.IsInherited -and $_.User -notlike 'NT AUTHORITY*' })
  } finally { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }
  Write-Note "Write blocked: $(-not $canWrite). Explicit grants readable on one shared mailbox: $($grants.Count)."
  if ($canWrite) { throw 'NO-GO: the app can write. Nothing was stored on Cloudflare. Run with -Rollback and check the role.' }
  if ($grants.Count -eq 0) { Write-Warning 'The sample shared mailbox has no explicit grants. Before turning dry run off, run the collector check in docs/m365-mailbox-permissions.md step 4 against a mailbox you know has Full Access.' }
  $go = $true
}

# ---- 5. Worker secrets ------------------------------------------------------
if ($go -and $PSCmdlet.ShouldProcess("Worker ($WranglerConfig)", 'store M365_EXO_CERT_PFX_B64 and M365_EXO_CERT_PASSWORD')) {
  $pfxFile = Join-Path $WorkDir 'cmail-exo-reader.pfx'
  $passwordPlain = New-RandomToken 24
  try {
    $password = ConvertTo-SecureString $passwordPlain -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $pfxFile -Password $password | Out-Null
    $pfxB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxFile))
    Set-WranglerSecret -Name M365_EXO_CERT_PFX_B64 -Value $pfxB64 -WranglerConfig $WranglerConfig -RepoRoot $RepoRoot
    Set-WranglerSecret -Name M365_EXO_CERT_PASSWORD -Value $passwordPlain -WranglerConfig $WranglerConfig -RepoRoot $RepoRoot
  } finally {
    Remove-Item -LiteralPath $pfxFile -Force -ErrorAction SilentlyContinue
    Remove-Variable passwordPlain, password, pfxB64 -ErrorAction SilentlyContinue
  }
  Write-Note 'The temporary PFX was deleted. The certificate stays in your CurrentUser\My store (needed for -Rollback and renewal).'
}

Write-Step 'Next: email Worker wrangler.toml'
Write-Note "[vars] M365_TENANT_ID = `"$TenantId`", M365_EXO_APP_ID = `"$appId`", M365_EXO_ORGANIZATION = `"$Organization`""
Write-Note 'Uncomment the container block (wrangler.toml.example), start Docker, apply migration 0028, deploy the Worker then the web app.'
Write-Note 'Admin > Shared mailbox access: Turn on (dry run stays on), read two reports, then turn dry run off.'
