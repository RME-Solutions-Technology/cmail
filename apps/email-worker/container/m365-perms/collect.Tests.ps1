#Requires -Version 7.2
<#
  Test harness for collect.ps1 with mocked Exchange cmdlets (no tenant, no
  module, no network). Run: pwsh -NoProfile -File collect.Tests.ps1 [-OutFile path]
  Exits 0 when every check passes. With -OutFile it also writes the mocked
  snapshot so the Worker's validator can check it (collector-script.node.test.ts).
  Fixtures use placeholder GUIDs and example.test addresses only.
#>
param([string]$OutFile = '')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'collect.ps1')

$failures = [System.Collections.Generic.List[string]]::new()
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { $failures.Add($Message) } }

$ids = @{
  shared1 = '00000000-0000-0000-0000-00000000a001'
  shared2 = '00000000-0000-0000-0000-00000000a002'
  shared3 = '00000000-0000-0000-0000-00000000a003'
  shared4 = '00000000-0000-0000-0000-00000000a004'
  shared5 = '00000000-0000-0000-0000-00000000a005'
  alice   = '00000000-0000-0000-0000-00000000b001'
  bob     = '00000000-0000-0000-0000-00000000b002'
  group   = '00000000-0000-0000-0000-00000000c001'
  room    = '00000000-0000-0000-0000-00000000d001'
}

# ─── Mocks: the module is never loaded, so these functions win ──────────
$script:Calls = [System.Collections.Generic.List[string]]::new()
$script:FailSendAsFor = ''

function Get-EXOMailbox {
  param($RecipientTypeDetails, $ResultSize, $ErrorAction)
  $script:Calls.Add('Get-EXOMailbox')
  if ($RecipientTypeDetails -ne 'SharedMailbox') { throw 'only shared mailboxes are asked for' }
  @(
    [pscustomobject]@{ ExternalDirectoryObjectId = $ids.shared2; PrimarySmtpAddress = 'Desk@Example.test' },
    [pscustomobject]@{ ExternalDirectoryObjectId = $ids.shared1; PrimarySmtpAddress = 'sales@example.test' },
    [pscustomobject]@{ ExternalDirectoryObjectId = $ids.shared3; PrimarySmtpAddress = 'support@example.test' },
    [pscustomobject]@{ ExternalDirectoryObjectId = $ids.shared4; PrimarySmtpAddress = 'legal@example.test' },
    [pscustomobject]@{ ExternalDirectoryObjectId = $ids.shared5; PrimarySmtpAddress = 'büro@example.test' },
    [pscustomobject]@{ ExternalDirectoryObjectId = ''; PrimarySmtpAddress = 'broken@example.test' }
  )
}

function Get-EXOMailboxPermission {
  param($Identity, $ResultSize, $ErrorAction)
  $script:Calls.Add("Get-EXOMailboxPermission:$Identity")
  switch ($Identity) {
    'sales@example.test' {
      [pscustomobject]@{ User = 'NT AUTHORITY\SELF'; AccessRights = @('ReadPermission'); IsInherited = $false; Deny = $false }
      [pscustomobject]@{ User = 'alice@example.test'; AccessRights = @('FullAccess'); IsInherited = $false; Deny = $false }
      [pscustomobject]@{ User = 'Sales Team'; AccessRights = @('FullAccess', 'ReadPermission'); IsInherited = $false; Deny = $false }
      [pscustomobject]@{ User = 'S-1-5-21-1111111111-2222222222-3333333333-1001'; AccessRights = @('FullAccess'); IsInherited = $false; Deny = $false }
      [pscustomobject]@{ User = 'bob@example.test'; AccessRights = @('FullAccess'); IsInherited = $true; Deny = $false }
    }
    'legal@example.test' {
      [pscustomobject]@{ User = 'alice@example.test'; AccessRights = @('FullAccess'); IsInherited = $false; Deny = $false }
      [pscustomobject]@{ User = 'bob@example.test'; AccessRights = @('FullAccess'); IsInherited = $false; Deny = $true }
    }
    'desk@example.test' {
      [pscustomobject]@{ User = 'bob@example.test'; AccessRights = 'FullAccess'; IsInherited = $false; Deny = $false }
      [pscustomobject]@{ User = 'meeting-room@example.test'; AccessRights = 'FullAccess'; IsInherited = $false; Deny = $false }
    }
    'support@example.test' {
      [pscustomobject]@{ User = 'someone-unknown'; AccessRights = 'FullAccess'; IsInherited = $false; Deny = $false }
    }
  }
}

function Get-EXORecipientPermission {
  param($Identity, $AccessRights, $ResultSize, $ErrorAction)
  $script:Calls.Add("Get-EXORecipientPermission:$Identity")
  if ($AccessRights -ne 'SendAs') { throw 'only Send As is asked for' }
  if ($Identity -eq $script:FailSendAsFor) { throw 'The server is busy (simulated)' }
  switch ($Identity) {
    'sales@example.test' {
      [pscustomobject]@{ Trustee = 'alice@example.test'; AccessRights = @('SendAs'); AccessControlType = 'Allow'; IsInherited = $false }
      [pscustomobject]@{ Trustee = 'NT AUTHORITY\SELF'; AccessRights = @('SendAs'); AccessControlType = 'Allow'; IsInherited = $false }
    }
    'desk@example.test' {
      [pscustomobject]@{ Trustee = 'alice@example.test'; AccessRights = @('SendAs'); AccessControlType = 'Allow'; IsInherited = $false }

    }
  }
}

function Get-EXORecipient {
  param($Identity, $ErrorAction)
  $script:Calls.Add("Get-EXORecipient:$Identity")
  switch ($Identity) {
    'alice@example.test' { [pscustomobject]@{ ExternalDirectoryObjectId = $ids.alice; RecipientTypeDetails = 'UserMailbox' } }
    'bob@example.test' { [pscustomobject]@{ ExternalDirectoryObjectId = $ids.bob; RecipientTypeDetails = 'UserMailbox' } }
    'Sales Team' { [pscustomobject]@{ ExternalDirectoryObjectId = $ids.group; RecipientTypeDetails = 'MailUniversalSecurityGroup' } }
    'meeting-room@example.test' { [pscustomobject]@{ ExternalDirectoryObjectId = $ids.room; RecipientTypeDetails = 'RoomMailbox' } }
    default { throw "Couldn't find object ""$Identity"" (simulated ManagementObjectNotFound)" }
  }
}

# A write cmdlet that must never be reachable through Invoke-Exo.
function Add-MailboxPermission { $script:Calls.Add('Add-MailboxPermission') }

# ─── 1. Full run ─────────────────────────────────────────────────────────
$snapshot = Get-PermissionSnapshot -TenantId '00000000-0000-0000-0000-000000000000' -Organization 'example.onmicrosoft.com' -Deadline (Get-Date).AddMinutes(5)
$json = ConvertTo-SnapshotJson $snapshot
$parsed = $json | ConvertFrom-Json -AsHashtable

Assert-True ($parsed.schema -eq 'cmail-exo-permissions' -and $parsed.version -eq 1) 'schema and version'
Assert-True ($parsed.mailboxCount -eq 4) 'four listable shared mailboxes (no object id, or an address the Worker would refuse, are skipped)'
Assert-True (($parsed.errors | Where-Object { $_.code -eq 'mailbox_address_unsupported' }).count -eq 1) 'unsupported address counted'
Assert-True ($parsed.complete -eq $true -and $parsed.nextCursor -eq '') 'complete run has no cursor'
Assert-True (($parsed.errors | Where-Object { $_.code -eq 'mailbox_without_object_id' }).count -eq 1) 'mailbox without object id counted'
$ordered = @($parsed.mailboxes | ForEach-Object { $_.id })
Assert-True (($ordered -join ',') -eq "$($ids.shared1),$($ids.shared2),$($ids.shared3),$($ids.shared4)") 'mailboxes sorted by object id'

$sales = $parsed.mailboxes | Where-Object { $_.id -eq $ids.shared1 }
Assert-True ($sales.address -eq 'sales@example.test') 'address lower case'
Assert-True ($sales.complete -eq $true) 'sales complete (system and orphaned entries are skipped, not unresolved)'
$alice = $sales.grants | Where-Object { $_.trustee -eq $ids.alice }
Assert-True ($alice.fullAccess -eq $true -and $alice.sendAs -eq $true -and $alice.kind -eq 'user') 'alice FA + SA on sales'
$group = $sales.grants | Where-Object { $_.trustee -eq $ids.group }
Assert-True ($group.kind -eq 'group' -and $group.fullAccess -eq $true -and $group.sendAs -eq $false) 'group FA on sales'
Assert-True (@($sales.grants | Where-Object { $_.trustee -eq $ids.bob }).Count -eq 0) 'inherited and deny entries are not grants'

$desk = $parsed.mailboxes | Where-Object { $_.id -eq $ids.shared2 }
Assert-True ($desk.address -eq 'desk@example.test') 'desk address lower case'
$bob = $desk.grants | Where-Object { $_.trustee -eq $ids.bob }
Assert-True ($bob.fullAccess -eq $true -and $bob.sendAs -eq $false) 'bob FA only on desk'
$aliceDesk = $desk.grants | Where-Object { $_.trustee -eq $ids.alice }
Assert-True ($aliceDesk.fullAccess -eq $false -and $aliceDesk.sendAs -eq $true) 'alice Send As only on desk'
Assert-True (@($desk.grants | Where-Object { $_.trustee -eq $ids.room }).Count -eq 0) 'room trustee skipped as otherKind'

$support = $parsed.mailboxes | Where-Object { $_.id -eq $ids.shared3 }
Assert-True ($support.complete -eq $false) 'unresolvable trustee marks the mailbox incomplete'
$legal = $parsed.mailboxes | Where-Object { $_.id -eq $ids.shared4 }
Assert-True ($legal.complete -eq $false -and @($legal.grants).Count -eq 0) 'a Deny entry freezes the mailbox: no grants, incomplete'
Assert-True (($parsed.errors | Where-Object { $_.code -eq 'deny_entries' }).count -eq 1) 'deny entries counted'
Assert-True ($parsed.skipped.inherited -eq 1 -and $parsed.skipped.deny -eq 1 -and $parsed.skipped.system -eq 1 -and $parsed.skipped.orphaned -eq 1 -and $parsed.skipped.unresolved -eq 1 -and $parsed.skipped.otherKind -eq 1) "skipped counts: $(($parsed.skipped | ConvertTo-Json -Compress))"
Assert-True ($json -notmatch 'NT AUTHORITY|Sales Team|S-1-5-21') 'no trustee names or SIDs in the output'

# ─── 2. Only allow-listed commands ran ───────────────────────────────────
$names = @($script:Calls | ForEach-Object { ($_ -split ':')[0] } | Sort-Object -Unique)
Assert-True (@($names | Where-Object { $script:AllowedCommands -notcontains $_ }).Count -eq 0) "only allow-listed commands ran: $($names -join ', ')"
Assert-True (@($script:AllowedCommands | Where-Object { $_ -notmatch '^(Get-|Connect-|Disconnect-)' }).Count -eq 0) 'allow-list holds read and session commands only'
$refused = $false
try { Invoke-Exo -Name 'Add-MailboxPermission' -Parameters @{} } catch { $refused = ((Get-ErrorCode $_) -eq 'command_not_allowed') }
Assert-True $refused 'a write cmdlet is refused by Invoke-Exo'
Assert-True (-not ($script:Calls -contains 'Add-MailboxPermission')) 'the write cmdlet never ran'

# ─── 3. A failed Send As query marks only that mailbox incomplete ────────
$script:FailSendAsFor = 'desk@example.test'
$partial = (ConvertTo-SnapshotJson (Get-PermissionSnapshot -TenantId '00000000-0000-0000-0000-000000000000' -Organization 'example.onmicrosoft.com' -Deadline (Get-Date).AddMinutes(5))) | ConvertFrom-Json -AsHashtable
$deskPartial = $partial.mailboxes | Where-Object { $_.id -eq $ids.shared2 }
Assert-True ($deskPartial.complete -eq $false) 'desk incomplete after a failed Send As query'
Assert-True (($partial.mailboxes | Where-Object { $_.id -eq $ids.shared1 }).complete -eq $true) 'sales still complete'
Assert-True (($partial.errors | Where-Object { $_.code -eq 'sendas_query_failed' }).count -eq 1) 'failure counted by code'
$script:FailSendAsFor = ''

# ─── 4. Deadline and cursor ──────────────────────────────────────────────
$late = (ConvertTo-SnapshotJson (Get-PermissionSnapshot -TenantId '00000000-0000-0000-0000-000000000000' -Organization 'example.onmicrosoft.com' -Deadline (Get-Date).AddMinutes(-1))) | ConvertFrom-Json -AsHashtable
Assert-True ($late.complete -eq $false -and @($late.mailboxes).Count -eq 0) 'past deadline: nothing collected, not complete'
$resumed = (ConvertTo-SnapshotJson (Get-PermissionSnapshot -TenantId '00000000-0000-0000-0000-000000000000' -Organization 'example.onmicrosoft.com' -StartAfter $ids.shared1 -Deadline (Get-Date).AddMinutes(5))) | ConvertFrom-Json -AsHashtable
Assert-True ((@($resumed.mailboxes | ForEach-Object { $_.id }) -join ',') -eq "$($ids.shared2),$($ids.shared3),$($ids.shared4),$($ids.shared1)") 'cursor starts after the given id and wraps'

# ─── 5. Error codes ──────────────────────────────────────────────────────
Assert-True ((Get-ErrorCode 'AADSTS700027: Client assertion failed') -eq 'credentials_rejected') 'AADSTS -> credentials_rejected'
Assert-True ((Get-ErrorCode "The term 'Get-EXORecipientPermission' is not recognized as a name of a cmdlet") -eq 'exchange_role_missing') 'missing cmdlet -> exchange_role_missing'
Assert-True ((Get-ErrorCode 'The request was throttled (429)') -eq 'throttled') 'throttled'

if ($OutFile) { Set-Content -LiteralPath $OutFile -Value $json -Encoding utf8NoBOM -NoNewline }

if ($failures.Count) {
  $failures | ForEach-Object { [Console]::Error.WriteLine("FAIL: $_") }
  exit 1
}
[Console]::Out.WriteLine('collect.ps1 harness: all checks passed')
exit 0
