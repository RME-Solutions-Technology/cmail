#Requires -Version 7.6
<#
.SYNOPSIS
  cmail shared mailbox access collector (read-only). docs/m365-mailbox-permissions.md

.DESCRIPTION
  Connects to Exchange Online app-only with a certificate, lists shared
  mailboxes and reads who holds Full Access and Send As on each, then writes
  one JSON snapshot (contract version 1) to $env:CMAIL_OUT_DIR/result.json.
  On failure it writes {"code": "<reason>"} to error.json and exits 1.

  Read-only by construction:
  - every Exchange command goes through Invoke-Exo, which refuses anything
    not in $AllowedCommands (Get-* plus Connect/Disconnect);
  - the Entra app should hold only a read-only Exchange role (see the docs);
  - the script never prints names or addresses to its output streams.

  Input (environment, never arguments):
    CMAIL_EXO_TENANT_ID, CMAIL_EXO_APP_ID, CMAIL_EXO_ORGANIZATION,
    CMAIL_EXO_CERT_PFX_B64, CMAIL_EXO_CERT_PASSWORD (optional),
    CMAIL_START_AFTER (optional cursor), CMAIL_DEADLINE_SECONDS, CMAIL_OUT_DIR.

  The same script can run outside Cloudflare (a scheduled task, Azure
  Automation) with the same variables; the output is the same contract.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'

$script:SchemaName = 'cmail-exo-permissions'
$script:SchemaVersion = 1
$script:GuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
# The same address rule the Worker's validator applies (snapshot.ts), so one
# unusual address is skipped here instead of rejecting the whole snapshot.
$script:AddressPattern = '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'

# The only Exchange commands this script may run. Get-* only, plus the
# session commands. Anything else is refused before it is called.
$script:AllowedCommands = @(
  'Connect-ExchangeOnline',
  'Disconnect-ExchangeOnline',
  'Get-EXOMailbox',
  'Get-EXOMailboxPermission',
  'Get-EXORecipientPermission',
  'Get-EXORecipient'
)

# Recipient types that are people (cmail accounts) or groups. Everything
# else (shared, room or equipment mailboxes as trustees, contacts, ...) is
# counted as otherKind and skipped.
$script:UserTypes = @('UserMailbox', 'MailUser', 'User', 'LinkedMailbox', 'RemoteUserMailbox', 'GuestMailUser')
$script:GroupTypes = @('MailUniversalSecurityGroup', 'UniversalSecurityGroup', 'SecurityGroup')

class CollectorException : System.Exception {
  [string]$Code
  CollectorException([string]$code) : base($code) { $this.Code = $code }
}

function Invoke-Exo {
  param(
    [Parameter(Mandatory)][string]$Name,
    [hashtable]$Parameters = @{}
  )
  if ($script:AllowedCommands -notcontains $Name) {
    throw [CollectorException]::new('command_not_allowed')
  }
  & $Name @Parameters
}

function Get-ErrorCode {
  param([object]$Failure)
  if ($Failure -is [System.Management.Automation.ErrorRecord] -and $Failure.Exception -is [CollectorException]) { return $Failure.Exception.Code }
  if ($Failure -is [CollectorException]) { return $Failure.Code }
  $text = "$Failure"
  if ($Failure -is [System.Management.Automation.ErrorRecord]) { $text = "$($Failure.Exception.Message) $($Failure.FullyQualifiedErrorId)" }
  # Entra sign-in failures: wrong app, wrong or expired certificate, no consent.
  if ($text -match 'AADSTS(700016|700027|7000215|7000222|50034|90002|500011|65001)') { return 'credentials_rejected' }
  if ($text -match 'is not recognized as (a|the) name of a cmdlet|CommandNotFoundException') { return 'exchange_role_missing' }
  # "Not found" first: its message may quote an address that looks like a status code.
  if ($text -match '(?i)couldn.t be found|could not be found|ManagementObjectNotFound') { return 'not_found' }
  if ($text -match '(?i)\b(401|403)\b|Unauthorized|Forbidden|access is denied|isn.t authorized|not authorized') { return 'unauthorized' }
  if ($text -match '(?i)\b429\b|throttl|server busy|too many requests|micro delay') { return 'throttled' }
  return 'exchange_error'
}

function Get-TrusteeSkip {
  param([string]$Name)
  if ([string]::IsNullOrWhiteSpace($Name)) { return 'unresolved' }
  # A bare SID is a deleted or synced-away account (orphaned entry).
  if ($Name -match '^S-1-5-21-[0-9-]+$') { return 'orphaned' }
  # Well-known system principals (NT AUTHORITY\SELF and the like).
  if ($Name -match '^S-1-[0-9-]+$' -or $Name -match '^(?i)NT AUTHORITY\\') { return 'system' }
  # Everything else is resolved; a name that cannot be resolved marks the
  # mailbox incomplete, so nothing is ever removed on a guess.
  return $null
}

function Resolve-Trustee {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][hashtable]$Cache
  )
  if ($Cache.ContainsKey($Name)) { return $Cache[$Name] }
  $result = $null
  try {
    $found = @(Invoke-Exo -Name 'Get-EXORecipient' -Parameters @{ Identity = $Name; ErrorAction = 'Stop' })
    if ($found.Count -eq 1) {
      $recipient = $found[0]
      $id = "$($recipient.ExternalDirectoryObjectId)".ToLowerInvariant()
      $type = "$($recipient.RecipientTypeDetails)"
      if ($id -notmatch $script:GuidPattern) {
        $result = @{ Skip = 'unresolved' }
      } elseif ($script:UserTypes -contains $type) {
        $result = @{ Id = $id; Kind = 'user' }
      } elseif ($script:GroupTypes -contains $type) {
        $result = @{ Id = $id; Kind = 'group' }
      } else {
        $result = @{ Skip = 'otherKind' }
      }
    } else {
      $result = @{ Skip = 'unresolved' }
    }
  } catch {
    $code = Get-ErrorCode $_
    if ($code -in @('exchange_role_missing', 'unauthorized', 'credentials_rejected')) { throw [CollectorException]::new($code) }
    if ($code -eq 'throttled') { throw [CollectorException]::new('throttled') }
    $result = @{ Skip = 'unresolved' }
  }
  $Cache[$Name] = $result
  return $result
}

function Test-HasRight {
  param([object]$AccessRights, [string]$Right)
  return ((@($AccessRights) | ForEach-Object { "$_" }) -join ',') -match "(^|[ ,])$Right($|[ ,])"
}

function Get-PermissionSnapshot {
  param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$Organization,
    [string]$StartAfter = '',
    [Parameter(Mandatory)][datetime]$Deadline
  )
  $skipped = [ordered]@{ inherited = 0; deny = 0; system = 0; orphaned = 0; unresolved = 0; otherKind = 0 }
  $errors = @{}
  $cache = @{}

  $all = @(Invoke-Exo -Name 'Get-EXOMailbox' -Parameters @{ RecipientTypeDetails = 'SharedMailbox'; ResultSize = 'Unlimited'; ErrorAction = 'Stop' })
  $shared = [System.Collections.Generic.List[object]]::new()
  foreach ($mailbox in $all) {
    $id = "$($mailbox.ExternalDirectoryObjectId)".ToLowerInvariant()
    $address = "$($mailbox.PrimarySmtpAddress)".ToLowerInvariant()
    if ($id -notmatch $script:GuidPattern) {
      $errors['mailbox_without_object_id'] = 1 + [int]($errors['mailbox_without_object_id'] ?? 0)
      continue
    }
    if ($address.Length -gt 254 -or $address -cnotmatch $script:AddressPattern) {
      # Not listed: the Worker keeps that mailbox's assignments as they are.
      $errors['mailbox_address_unsupported'] = 1 + [int]($errors['mailbox_address_unsupported'] ?? 0)
      continue
    }
    $shared.Add([pscustomobject]@{ Id = $id; Address = $address })
  }
  $ordered = @($shared | Sort-Object -Property Id -CaseSensitive)
  $total = $ordered.Count

  # Start after the cursor (large tenants are covered over several runs), then wrap.
  $start = 0
  if ($StartAfter -match $script:GuidPattern) {
    $start = $total
    for ($i = 0; $i -lt $total; $i++) {
      if ([string]::CompareOrdinal($ordered[$i].Id, $StartAfter) -gt 0) { $start = $i; break }
    }
    if ($start -ge $total) { $start = 0 }
  }

  $out = [System.Collections.Generic.List[object]]::new()
  $lastId = ''
  for ($n = 0; $n -lt $total; $n++) {
    if ((Get-Date) -gt $Deadline) { break }
    $mailbox = $ordered[($start + $n) % $total]
    $complete = $true
    $hasDeny = $false
    $rights = [ordered]@{}

    try {
      $fullAccess = @(Invoke-Exo -Name 'Get-EXOMailboxPermission' -Parameters @{ Identity = $mailbox.Address; ResultSize = 'Unlimited'; ErrorAction = 'Stop' })
      foreach ($entry in $fullAccess) {
        if (-not (Test-HasRight $entry.AccessRights 'FullAccess')) { continue }
        if ($entry.IsInherited) { $skipped.inherited++; continue }
        if ($entry.Deny) { $skipped.deny++; $hasDeny = $true; continue }
        $name = "$($entry.User)"
        $skip = Get-TrusteeSkip $name
        if ($skip) { $skipped[$skip]++; if ($skip -eq 'unresolved') { $complete = $false }; continue }
        $trustee = Resolve-Trustee -Name $name -Cache $cache
        if ($trustee.ContainsKey('Skip')) { $skipped[$trustee.Skip]++; if ($trustee.Skip -eq 'unresolved') { $complete = $false }; continue }
        $current = $rights[$trustee.Id] ?? @{ Kind = $trustee.Kind; FullAccess = $false; SendAs = $false }
        $current.FullAccess = $true
        $rights[$trustee.Id] = $current
      }
    } catch {
      $code = Get-ErrorCode $_
      if ($code -in @('exchange_role_missing', 'unauthorized', 'credentials_rejected', 'command_not_allowed')) { throw [CollectorException]::new($code) }
      $errors['fullaccess_query_failed'] = 1 + [int]($errors['fullaccess_query_failed'] ?? 0)
      $complete = $false
    }

    try {
      $sendAs = @(Invoke-Exo -Name 'Get-EXORecipientPermission' -Parameters @{ Identity = $mailbox.Address; AccessRights = 'SendAs'; ResultSize = 'Unlimited'; ErrorAction = 'Stop' })
      foreach ($entry in $sendAs) {
        if (-not (Test-HasRight $entry.AccessRights 'SendAs')) { continue }
        if ($entry.IsInherited) { $skipped.inherited++; continue }
        if ("$($entry.AccessControlType)" -ne 'Allow') { $skipped.deny++; $hasDeny = $true; continue }
        $name = "$($entry.Trustee)"
        $skip = Get-TrusteeSkip $name
        if ($skip) { $skipped[$skip]++; if ($skip -eq 'unresolved') { $complete = $false }; continue }
        $trustee = Resolve-Trustee -Name $name -Cache $cache
        if ($trustee.ContainsKey('Skip')) { $skipped[$trustee.Skip]++; if ($trustee.Skip -eq 'unresolved') { $complete = $false }; continue }
        $current = $rights[$trustee.Id] ?? @{ Kind = $trustee.Kind; FullAccess = $false; SendAs = $false }
        $current.SendAs = $true
        $rights[$trustee.Id] = $current
      }
    } catch {
      $code = Get-ErrorCode $_
      if ($code -in @('exchange_role_missing', 'unauthorized', 'credentials_rejected', 'command_not_allowed')) { throw [CollectorException]::new($code) }
      $errors['sendas_query_failed'] = 1 + [int]($errors['sendas_query_failed'] ?? 0)
      $complete = $false
    }

    $grants = [System.Collections.Generic.List[object]]::new()
    if ($hasDeny) {
      # Exchange applies Deny over Allow (also through groups). cmail cannot
      # model that, so a mailbox with any Deny entry is listed with no grants
      # and as incomplete: the Worker then neither adds nor removes there.
      $errors['deny_entries'] = 1 + [int]($errors['deny_entries'] ?? 0)
      $complete = $false
      $rights = [ordered]@{}
    }
    foreach ($trusteeId in $rights.Keys) {
      if ($trusteeId -eq $mailbox.Id) { continue }
      $grant = $rights[$trusteeId]
      $grants.Add([ordered]@{ trustee = $trusteeId; kind = $grant.Kind; fullAccess = [bool]$grant.FullAccess; sendAs = [bool]$grant.SendAs })
    }
    $out.Add([ordered]@{ id = $mailbox.Id; address = $mailbox.Address; complete = $complete; grants = $grants.ToArray() })
    $lastId = $mailbox.Id
  }

  $isComplete = ($out.Count -eq $total)
  $errorList = [System.Collections.Generic.List[object]]::new()
  foreach ($code in ($errors.Keys | Sort-Object)) { $errorList.Add([ordered]@{ code = $code; count = [int]$errors[$code] }) }
  return [ordered]@{
    schema       = $script:SchemaName
    version      = $script:SchemaVersion
    tenantId     = $TenantId
    organization = $Organization
    collectedAt  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    complete     = $isComplete
    nextCursor   = $(if ($isComplete) { '' } else { $lastId })
    mailboxCount = $total
    mailboxes    = $out.ToArray()
    skipped      = $skipped
    errors       = $errorList.ToArray()
  }
}

function ConvertTo-SnapshotJson {
  param([Parameter(Mandatory)][System.Collections.IDictionary]$Snapshot)
  return ConvertTo-Json -InputObject $Snapshot -Depth 8 -Compress
}

function Write-Failure {
  param([string]$OutDir, [string]$Code)
  if ($Code -notmatch '^[a-z_]{1,48}$') { $Code = 'collector_failed' }
  $null = New-Item -ItemType Directory -Force -Path $OutDir
  Set-Content -LiteralPath (Join-Path $OutDir 'error.json') -Value (ConvertTo-Json -InputObject @{ code = $Code } -Compress) -Encoding utf8NoBOM -NoNewline
}

function Invoke-Collector {
  $outDir = if ($env:CMAIL_OUT_DIR) { $env:CMAIL_OUT_DIR } else { '/tmp/cmail-out' }
  $connected = $false
  try {
    $tenantId = "$env:CMAIL_EXO_TENANT_ID".Trim().ToLowerInvariant()
    $appId = "$env:CMAIL_EXO_APP_ID".Trim().ToLowerInvariant()
    $organization = "$env:CMAIL_EXO_ORGANIZATION".Trim().ToLowerInvariant()
    $pfx = "$env:CMAIL_EXO_CERT_PFX_B64".Trim()
    if ($tenantId -notmatch $script:GuidPattern -or $appId -notmatch $script:GuidPattern -or $organization -notmatch '^[a-z0-9-]{1,63}\.onmicrosoft\.(com|us|de)$' -or -not $pfx) {
      throw [CollectorException]::new('config_missing')
    }
    $seconds = 600
    if ("$env:CMAIL_DEADLINE_SECONDS" -match '^\d{1,5}$') { $seconds = [Math]::Min([int]$env:CMAIL_DEADLINE_SECONDS, 780) }
    $deadline = (Get-Date).AddSeconds($seconds)

    try {
      $bytes = [Convert]::FromBase64String($pfx)
      $password = if ($env:CMAIL_EXO_CERT_PASSWORD) { $env:CMAIL_EXO_CERT_PASSWORD } else { $null }
      $certificate = [System.Security.Cryptography.X509Certificates.X509CertificateLoader]::LoadPkcs12(
        $bytes, $password, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
    } catch {
      throw [CollectorException]::new('certificate_unreadable')
    }
    if (-not $certificate.HasPrivateKey) { throw [CollectorException]::new('certificate_unreadable') }

    try {
      Import-Module ExchangeOnlineManagement -ErrorAction Stop
      Invoke-Exo -Name 'Connect-ExchangeOnline' -Parameters @{
        Certificate  = $certificate
        AppId        = $appId
        Organization = $organization
        ShowBanner   = $false
        ErrorAction  = 'Stop'
      } | Out-Null
      $connected = $true
    } catch {
      $code = Get-ErrorCode $_
      if ($code -eq 'exchange_error') { $code = 'connect_failed' }
      throw [CollectorException]::new($code)
    }

    $snapshot = Get-PermissionSnapshot -TenantId $tenantId -Organization $organization -StartAfter "$env:CMAIL_START_AFTER".Trim().ToLowerInvariant() -Deadline $deadline
    $null = New-Item -ItemType Directory -Force -Path $outDir
    Set-Content -LiteralPath (Join-Path $outDir 'result.json') -Value (ConvertTo-SnapshotJson $snapshot) -Encoding utf8NoBOM -NoNewline
    return 0
  } catch {
    Write-Failure -OutDir $outDir -Code (Get-ErrorCode $_)
    return 1
  } finally {
    if ($connected) {
      try { Invoke-Exo -Name 'Disconnect-ExchangeOnline' -Parameters @{ Confirm = $false; ErrorAction = 'SilentlyContinue' } | Out-Null } catch { $null = $_ }
    }
  }
}

# Run only when executed, not when dot-sourced by the test harness.
if ($MyInvocation.InvocationName -ne '.') {
  exit (Invoke-Collector)
}
