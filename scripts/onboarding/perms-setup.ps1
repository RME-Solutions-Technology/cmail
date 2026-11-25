#Requires -Version 7.2

<#
.SYNOPSIS
  One-time tenant setup for Stanchion's shared mailbox access sync (read-only
  toward Exchange): Entra app with Exchange.ManageAsApp, a certificate, a
  read-only custom Exchange role in its own role group, the go/no-go check,
  and the certificate stored as email Worker secrets. -Rollback undoes it.

.DESCRIPTION
  Step 11 of docs/onboarding-microsoft-365.md; the feature is
  docs/m365-mailbox-permissions.md (steps 1 to 5 there).

  What it does, in order, stopping at the first error:
  0. Pre-flight, before anything is created: az is in the right tenant and
     the signed-in admin has active Global Administrator, or Privileged Role
     Administrator plus (Cloud) Application Administrator, and Exchange
     Administrator (or Global Administrator). Activate PIM roles first, then
     run `az login` again.
  1. Entra app (single tenant, no redirect URI) with the Office 365 Exchange
     Online application permission Exchange.ManageAsApp. Admin consent is
     tried; if it does not apply the app role (seen on a live tenant), the
     role is granted directly (appRoleAssignedTo) and read back.
  2. A certificate: an existing one in CurrentUser\My (subject CN=<AppName>,
     private key present, more than 30 days left, already on the app) is
     reused; otherwise a new self-signed one with a CSP key (-KeySpec
     KeyExchange; the Exchange module does not support CNG keys here) is made
     and its public part uploaded. Windows only (New-SelfSignedCertificate).
  3. Exchange (delegated sign-in as an admin): organisation customisation if
     needed, a custom role from "Mail Recipients" trimmed to exactly six read
     cmdlets, a role group holding only that role, the app's Exchange service
     principal as its member. Stops (no-go) if the role is not exactly those six.
  4. Go / no-go as the app: no write cmdlet (Add-/Remove-MailboxPermission,
     Add-/Remove-RecipientPermission, Set-Mailbox) may be available to the
     app's session, and a shared mailbox's grants must be readable. Any
     unexpected error is a no-go. No-go stores nothing.
  5. GO: the PFX (base64) and a random password are piped into the email
     Worker secrets M365_EXO_CERT_PFX_B64 and M365_EXO_CERT_PASSWORD. Never
     printed, never an argument. The PFX file exists only between export and
     upload, in -WorkDir, and is deleted in all cases.

  The certificate's private key stays in your CurrentUser\My store (needed to
  rerun, renew and for -Rollback) unless you pass -RemoveLocalCertificate.
  The Worker secret is then the only copy.

  Then: [vars] M365_EXO_APP_ID and M365_EXO_ORGANIZATION, the container block
  in wrangler.toml, Docker running on the deploying machine, migration 0028,
  deploy, and Admin > Shared mailbox access in dry run.

.PARAMETER TenantId
  Directory (tenant) ID, a GUID.
.PARAMETER Organization
  The tenant's initial domain, <name>.onmicrosoft.com (used for app-only sign-in).
.PARAMETER WranglerConfig
  The email Worker's wrangler.toml (the instance's own). Required except with -Rollback.
.PARAMETER AppName
  Entra app display name; also the certificate subject.
.PARAMETER RoleName
  Custom Exchange management role name.
.PARAMETER RoleGroupName
  Exchange role group name.
.PARAMETER CertMonths
  Lifetime in months (1 to 24) of a new certificate. Renew before it ends.
.PARAMETER WorkDir
  Folder for the temporary .cer and .pfx files. Default: a new folder under the system temp directory.
.PARAMETER UserPrincipalName
  Optional admin sign-in name for the delegated Exchange connection.
.PARAMETER ExchangeModuleVersion
  ExchangeOnlineManagement version; the collector image pins 3.11.1.
.PARAMETER PropagationWaitSeconds
  Wait after the Exchange changes before the go/no-go check (Exchange RBAC takes time to apply).
.PARAMETER ConsentWaitSeconds
  How long to wait for admin consent to show before granting the app role directly.
.PARAMETER RemoveLocalCertificate
  After the secrets are stored, delete the certificate and its private key from CurrentUser\My.
.PARAMETER Rollback
  Remove the role group, the role, the Exchange service principal, the Entra
  app and the local certificate. Worker secrets are left (harmless with the
  feature off; delete them with wrangler secret delete if you want).
.PARAMETER RepoRoot
  The Stanchion checkout that has Wrangler installed. Defaults to this repository.

.EXAMPLE
  pwsh -File scripts/onboarding/perms-setup.ps1 -TenantId 00000000-0000-0000-0000-000000000000 -Organization example.onmicrosoft.com -WranglerConfig apps/email-worker/wrangler.toml -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$TenantId,
  [Parameter(Mandatory)][string]$Organization,
  [string]$WranglerConfig = '',
  [string]$AppName = 'cmail Exchange permission reader',
  [string]$RoleName = 'cmail Mailbox Access Reader (Mail Recipients)',
  [string]$RoleGroupName = 'cmail Mailbox Access Readers',
  [ValidateRange(1, 24)][int]$CertMonths = 12,
  [string]$WorkDir = '',
  [string]$UserPrincipalName = '',
  [string]$ExchangeModuleVersion = '3.11.1',
  [ValidateRange(0, 600)][int]$PropagationWaitSeconds = 60,
  [ValidateRange(0, 600)][int]$ConsentWaitSeconds = 30,
  [switch]$RemoveLocalCertificate,
  [switch]$Rollback,
  [string]$RepoRoot = ''
)

. (Join-Path $PSScriptRoot '_common.ps1')
Assert-Guid $TenantId 'TenantId'
if ($Organization -notmatch '^[a-z0-9-]+\.onmicrosoft\.com$') { throw 'Organization must be the tenant''s <name>.onmicrosoft.com domain.' }
if (-not $RepoRoot) { $RepoRoot = Get-RepoRoot }
if (-not $Rollback -and -not $WranglerConfig) { throw 'Setup needs -WranglerConfig: the email Worker''s wrangler.toml.' }
$ownWorkDir = -not $WorkDir
if (-not $WorkDir) { $WorkDir = Join-Path ([IO.Path]::GetTempPath()) ("cmail-perms-{0}" -f [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$dryRun = [bool]$WhatIfPreference
$readCmdlets = 'Get-Mailbox', 'Get-MailboxPermission', 'Get-RecipientPermission', 'Get-Recipient', 'Get-User', 'Get-Group'
$writeCmdlets = 'Add-MailboxPermission', 'Remove-MailboxPermission', 'Add-RecipientPermission', 'Remove-RecipientPermission', 'Set-Mailbox'

function Connect-ExoAdmin([string]$Upn) {
  $connect = @{ ShowBanner = $false }
  if ($Upn) { $connect.UserPrincipalName = $Upn }
  Connect-ExchangeOnline @connect -ErrorAction Stop
}

function Get-LocalCertificates {
  if (-not (Test-Path 'Cert:\CurrentUser\My')) { return @() }
  @(Get-ChildItem 'Cert:\CurrentUser\My' | Where-Object Subject -EQ "CN=$AppName")
}

if ($dryRun) {
  Write-Note 'Dry run: no sign-in to Entra, Exchange or Cloudflare; showing what would change.'
} else {
  Assert-AzTenant $TenantId
  if ($Rollback) { Assert-AdminRoles -Need AppRegistration, Exchange }
  else { Assert-AdminRoles -Need AppRegistration, AppRoleConsent, Exchange }
  Import-ExchangeModule $ExchangeModuleVersion
  if (-not $Rollback) { $WranglerConfig = Resolve-WranglerConfig $WranglerConfig }
}

# Removes the temporary work folder when this script made it.
function Remove-WorkDir { if ($ownWorkDir -and (Test-Path -LiteralPath $WorkDir)) { Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue } }

# ---- Rollback -------------------------------------------------------------
if ($Rollback) {
  Write-Step 'Rolling back the shared mailbox access setup'
  $appId = if ($dryRun) { '<app id>' } else { Find-EntraApp $AppName }
  if (-not $dryRun) { Connect-ExoAdmin $UserPrincipalName }
  try {
    if ($PSCmdlet.ShouldProcess("role group '$RoleGroupName'", 'remove')) {
      if (Get-ExoOrNull { Get-RoleGroup -Identity $RoleGroupName -ErrorAction Stop }) { Remove-RoleGroup -Identity $RoleGroupName -Confirm:$false -ErrorAction Stop }
    }
    if ($PSCmdlet.ShouldProcess("management role '$RoleName'", 'remove')) {
      if (Get-ExoOrNull { Get-ManagementRole -Identity $RoleName -ErrorAction Stop }) { Remove-ManagementRole -Identity $RoleName -Confirm:$false -ErrorAction Stop }
    }
    # By app id when the Entra app still exists; otherwise by display name, so an
    # Exchange service principal left behind by a deleted app is removed too.
    $exoSps = if ($dryRun) { @() }
              elseif ($appId) { @(Get-ExoOrNull { Get-ServicePrincipal -Identity $appId -ErrorAction Stop }) }
              else { @(Get-ServicePrincipal -ErrorAction Stop | Where-Object DisplayName -EQ $AppName) }
    $label = if ($appId) { $appId } else { "'$AppName'" }
    if ($PSCmdlet.ShouldProcess("Exchange service principal for $label", 'remove')) {
      foreach ($sp in @($exoSps | Where-Object { $_ })) { Remove-ServicePrincipal -Identity $sp.AppId -Confirm:$false -ErrorAction Stop }
    }
  } finally { if (-not $dryRun) { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue } }
  if ($appId -and $PSCmdlet.ShouldProcess("Entra app $appId", 'delete')) { Invoke-Az ad app delete --id $appId | Out-Null }
  if ($PSCmdlet.ShouldProcess("certificate CN=$AppName in CurrentUser\My", 'remove')) {
    Get-LocalCertificates | Remove-Item -Force
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
if ($PSCmdlet.ShouldProcess("Entra app $appId", 'create service principal and grant Exchange.ManageAsApp (admin consent, else direct assignment)')) {
  $roleId = Get-ResourcePermissionId -ResourceAppId $script:ExchangeResourceAppId -Value 'Exchange.ManageAsApp' -Kind Role
  $spObjectId = Get-FirstLine (Invoke-Az ad sp list --filter "appId eq '$appId'" --query '[].id' -o tsv)
  if (-not $spObjectId) {
    $spObjectId = Get-FirstLine (Invoke-Az ad sp create --id $appId --query id -o tsv)
    if ($ConsentWaitSeconds) { Start-Sleep -Seconds 15 }  # a new service principal takes a moment to be usable for consent
  }
  Assert-Guid $spObjectId 'Service principal object id'
  Grant-AppRoles -AppId $appId -ServicePrincipalId $spObjectId -ResourceAppId $script:ExchangeResourceAppId -RoleIds @($roleId) -WaitSeconds $ConsentWaitSeconds
  Write-Note 'Exchange.ManageAsApp granted and checked.'
}

# ---- 2. Certificate -------------------------------------------------------
Write-Step '2. Certificate (CSP key, exportable)'
$cert = $null
if ($PSCmdlet.ShouldProcess("Entra app $appId", "reuse a valid certificate on the app, or create a $CertMonths-month self-signed one and upload its public part")) {
  # Key credentials already on the app, as thumbprints (hex) or their base64 form.
  $onApp = @(Invoke-Az ad app credential list --id $appId --cert --query '[].customKeyIdentifier' -o tsv | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() })
  $cert = Get-LocalCertificates | Where-Object {
    $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(30) -and
    ($onApp -contains $_.Thumbprint -or $onApp -contains [Convert]::ToBase64String([Convert]::FromHexString($_.Thumbprint)))
  } | Sort-Object NotAfter -Descending | Select-Object -First 1
  if ($cert) {
    Write-Note "Reusing certificate $($cert.Thumbprint) (expires $($cert.NotAfter.ToString('yyyy-MM-dd'))); nothing added to the app."
  } else {
    if (-not (Get-Command New-SelfSignedCertificate -ErrorAction SilentlyContinue)) {
      throw 'New-SelfSignedCertificate is not available: run this step on Windows (docs/m365-mailbox-permissions.md, step 2).'
    }
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    $cert = New-SelfSignedCertificate -Subject "CN=$AppName" -CertStoreLocation 'Cert:\CurrentUser\My' -KeySpec KeyExchange `
      -KeyExportPolicy Exportable -NotAfter (Get-Date).AddMonths($CertMonths)
    $cerFile = Join-Path $WorkDir 'cmail-exo-reader.cer'
    try {
      Export-Certificate -Cert $cert -FilePath $cerFile | Out-Null
      Invoke-Az ad app credential reset --id $appId --cert "@$cerFile" --append | Out-Null
    } finally {
      Remove-Item -LiteralPath $cerFile -Force -ErrorAction SilentlyContinue
      Remove-WorkDir
    }
    Write-Note "Certificate $($cert.Thumbprint) expires $($cert.NotAfter.ToString('yyyy-MM-dd')). Record it and renew before then."
  }
}

if (-not $cert -and -not $dryRun) { Write-Warning 'Stopped: no certificate (the step was declined). Nothing else was done.'; return }

# ---- 3. Exchange role, role group, service principal ----------------------
Write-Step '3. Exchange: read-only role, role group, service principal'
if ($PSCmdlet.ShouldProcess('Exchange Online', "custom role '$RoleName' ($($readCmdlets -join ', ')), role group '$RoleGroupName', service principal for $appId")) {
  Connect-ExoAdmin $UserPrincipalName
  try {
    if ((Get-OrganizationConfig -ErrorAction Stop).IsDehydrated) { Enable-OrganizationCustomization -ErrorAction Stop }
    if (-not (Get-ExoOrNull { Get-ManagementRole -Identity $RoleName -ErrorAction Stop })) {
      New-ManagementRole -Name $RoleName -Parent 'Mail Recipients' -ErrorAction Stop | Out-Null
      Get-ManagementRoleEntry "$RoleName\*" -ErrorAction Stop | Where-Object { $readCmdlets -notcontains $_.Name } |
        ForEach-Object { Remove-ManagementRoleEntry -Identity "$RoleName\$($_.Name)" -Confirm:$false -ErrorAction Stop }
    }
    $have = @((Get-ManagementRoleEntry "$RoleName\*" -ErrorAction Stop).Name | Sort-Object)
    $missing = @($readCmdlets | Where-Object { $have -notcontains $_ })
    $extra = @($have | Where-Object { $readCmdlets -notcontains $_ })
    Write-Note "Role holds: $($have -join ', ')"
    if ($missing.Count -or $extra.Count) {
      throw "NO-GO: the role must hold exactly the six read cmdlets (missing: $($missing -join ', '); extra: $($extra -join ', ')). Fix by hand (docs/m365-mailbox-permissions.md step 3) or run -Rollback."
    }
    if (-not (Get-ExoOrNull { Get-RoleGroup -Identity $RoleGroupName -ErrorAction Stop })) {
      New-RoleGroup -Name $RoleGroupName -Roles $RoleName -Description 'Read-only: Full Access and Send As on shared mailboxes for Stanchion' -ErrorAction Stop | Out-Null
    }
    if (-not (Get-ExoOrNull { Get-ServicePrincipal -Identity $appId -ErrorAction Stop })) {
      New-ServicePrincipal -AppId $appId -ObjectId $spObjectId -DisplayName $AppName -ErrorAction Stop | Out-Null
    }
    try { Add-RoleGroupMember -Identity $RoleGroupName -Member $spObjectId -ErrorAction Stop }
    catch { if ("$_" -notmatch 'already a member') { throw } }
  } finally { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }
  if ($PropagationWaitSeconds -gt 0) { Write-Note "Waiting $PropagationWaitSeconds s for Exchange permissions to apply..."; Start-Sleep -Seconds $PropagationWaitSeconds }
}

# ---- 4. Go / no-go, as the app ---------------------------------------------
Write-Step '4. Go / no-go as the app'
$go = $false
if ($PSCmdlet.ShouldProcess("Exchange Online as app $appId", 'check no write cmdlet is available and a shared mailbox''s grants are readable')) {
  Connect-ExchangeOnline -Certificate $cert -AppId $appId -Organization $Organization -ShowBanner:$false -ErrorAction Stop
  try {
    # The module exposes only the cmdlets the app's roles allow. A write
    # cmdlet being present at all is a no-go; nothing is attempted.
    $writable = @($writeCmdlets | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue })
    if ($writable.Count) { throw "NO-GO: the app can run $($writable -join ', '). Nothing was stored on Cloudflare. Run with -Rollback and check the role." }
    $shared = Get-EXOMailbox -RecipientTypeDetails SharedMailbox -ResultSize 1 -ErrorAction Stop
    if (-not $shared) { throw 'NO-GO (undetermined): the tenant has no shared mailbox to test with. Create one, then run again.' }
    $grants = @(Get-EXOMailboxPermission -Identity $shared.PrimarySmtpAddress -ErrorAction Stop |
      Where-Object { -not $_.IsInherited -and $_.User -notlike 'NT AUTHORITY*' })
  } finally { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }
  Write-Note "No write cmdlet available. Explicit grants readable on one shared mailbox: $($grants.Count)."
  if ($grants.Count -eq 0) { Write-Warning 'The sample shared mailbox has no explicit grants. Before turning dry run off, run the collector check in docs/m365-mailbox-permissions.md step 4 against a mailbox you know has Full Access.' }
  $go = $true
}

# ---- 5. Worker secrets ------------------------------------------------------
if ($go -and $PSCmdlet.ShouldProcess("Worker ($WranglerConfig)", 'store M365_EXO_CERT_PFX_B64 and M365_EXO_CERT_PASSWORD')) {
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
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
    Remove-WorkDir
    Remove-Variable passwordPlain, password, pfxB64 -ErrorAction SilentlyContinue
  }
  Write-Note 'The temporary PFX was deleted.'
  if ($RemoveLocalCertificate) {
    if ($PSCmdlet.ShouldProcess("certificate $($cert.Thumbprint) in CurrentUser\My", 'delete with its private key')) {
      Get-LocalCertificates | Where-Object Thumbprint -EQ $cert.Thumbprint | Remove-Item -Force
      Write-Note 'Local certificate and private key deleted; the Worker secret is now the only copy (a rerun makes a new certificate).'
    }
  } else {
    Write-Note 'The certificate and its private key stay in CurrentUser\My (reused on rerun; needed to renew). Pass -RemoveLocalCertificate to delete them.'
  }
}

Write-Step 'Next: email Worker wrangler.toml'
Write-Note "[vars] M365_TENANT_ID = `"$TenantId`", M365_EXO_APP_ID = `"$appId`", M365_EXO_ORGANIZATION = `"$Organization`""
Write-Note 'Uncomment the container block (wrangler.toml.example), start Docker, apply migration 0028, deploy the Worker then the web app.'
Write-Note 'Admin > Shared mailbox access: Turn on (dry run stays on), read two reports, then turn dry run off.'
