#Requires -Version 7.2

<#
  Checks for the onboarding scripts, with no tenant, no Cloudflare account and
  no network: az, pnpm (Wrangler) and the Exchange cmdlets are replaced by
  local functions that record their calls.

  Run: pwsh -NoProfile -File scripts/onboarding/onboarding.Tests.ps1
  Exits 0 when every check passes.

  What it checks:
  - every script parses, is ASCII, has help for itself and every parameter,
    and `pwsh -File <script> -?` works;
  - no real-looking identifiers: GUIDs other than the zero placeholder and
    Microsoft's well-known resource app ids are refused;
  - -WhatIf calls nothing outside PowerShell;
  - secrets go to Wrangler's stdin only and never to any output stream;
  - the Exchange mirror saves and restores the previous NDR address and
    creates its journal rule disabled;
  - the permission setup stores nothing when the app can write (no-go).
  - PSScriptAnalyzer, when installed, reports no warnings or errors.
#>
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$scripts = 'new-signin-app.ps1', 'set-bootstrap-secrets.ps1', 'new-sync-app.ps1', 'exchange-mirror.ps1', 'perms-setup.ps1'
$failures = [System.Collections.Generic.List[string]]::new()
function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { $failures.Add($Message) } }

$global:Mock_tenant = '00000000-0000-0000-0000-000000000001'
$global:Mock_newApp = '00000000-0000-0000-0000-000000000002'
$global:Mock_spId = '00000000-0000-0000-0000-000000000003'
$global:Mock_fakeSecret = 'fake-client-secret-value-for-tests'
$work = Join-Path ([IO.Path]::GetTempPath()) ("cmail-onboarding-tests-{0}" -f [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$wranglerToml = Join-Path $work 'wrangler.toml'
Set-Content -LiteralPath $wranglerToml -Value '# test' -Encoding ascii

# ---- Recording mocks ------------------------------------------------------
$global:MockCalls = [System.Collections.Generic.List[object]]::new()
$global:MockAzTenant = $global:Mock_tenant
$global:MockAppExists = $false
$global:MockGranted = @()

function Reset-Mocks { $global:MockCalls.Clear(); $global:MockAppExists = $false; $global:MockGranted = @() }
function Get-CallsOf([string]$Tool) { @($global:MockCalls | Where-Object Tool -EQ $Tool) }

function az {
  $line = $args -join ' '
  $global:MockCalls.Add([pscustomobject]@{ Tool = 'az'; Args = $line; Stdin = '' })
  $global:LASTEXITCODE = 0
  switch -Regex ($line) {
    '^account show' { return $global:MockAzTenant }
    '^ad app list' { if ($global:MockAppExists) { return $global:Mock_newApp } else { return } }
    '^ad sp show --id \S+ --query (appRoles|oauth2PermissionScopes)' {
      $v = [regex]::Match($line, "value=='([^']+)'").Groups[1].Value
      $n = [Math]::Abs($v.GetHashCode()) % 9000 + 1000
      return "00000000-0000-0000-0000-00000000$n"
    }
    '^ad app create' { $global:MockAppExists = $true; return $global:Mock_newApp }
    '^ad sp list' { return }
    '^ad sp create' { return $global:Mock_spId }
    '^ad app permission admin-consent' {
      $global:MockGranted = @($global:MockCalls | Where-Object { $_.Tool -eq 'az' -and $_.Args -match '^ad sp show --id \S+ --query appRoles' } |
        ForEach-Object { $v = [regex]::Match($_.Args, "value=='([^']+)'").Groups[1].Value; "00000000-0000-0000-0000-00000000$([Math]::Abs($v.GetHashCode()) % 9000 + 1000)" })
      return
    }
    '^rest --method GET' { return $global:MockGranted }
    '^ad app credential reset .*--query password' { return $global:Mock_fakeSecret }
    default { return }
  }
}

function pnpm {
  $stdin = @($input) -join "`n"
  $global:MockCalls.Add([pscustomobject]@{ Tool = 'pnpm'; Args = ($args -join ' '); Stdin = $stdin })
  $global:LASTEXITCODE = 0
  'Success! Uploaded secret'
}

function Set-Clipboard { param($Value) $global:MockCalls.Add([pscustomobject]@{ Tool = 'clipboard'; Args = ''; Stdin = [string]$Value }) }

function Invoke-Script([string]$Name, [hashtable]$Params) {
  # All streams captured, so a leak to any of them is found.
  $out = & (Join-Path $here $Name) @Params *>&1 | Out-String
  $out
}

# ---- Static checks --------------------------------------------------------
$allowedGuids = @('00000000-0000-0000-0000-000000000000', '00000003-0000-0000-c000-000000000000', '00000002-0000-0ff1-ce00-000000000000')
# Every host in a URL or email address must be a placeholder or a public vendor endpoint.
$allowedHosts = '(^|\.)(example\.(com|net|org)|[a-z0-9-]+\.test|microsoft\.com|microsoftonline\.com|cloudflare\.com|pages\.dev|outlook\.com|onmicrosoft\.com)$'
foreach ($file in @($scripts + '_common.ps1' + 'README.md' + '../../docs/onboarding-microsoft-365.md')) {
  $path = Join-Path $here $file
  $bytes = [IO.File]::ReadAllBytes($path)
  Assert-True (-not ($bytes | Where-Object { $_ -gt 127 })) "$file is not ASCII"
  $text = [IO.File]::ReadAllText($path)
  foreach ($m in [regex]::Matches($text, '(?:https?://|@)([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)')) {
    $hostName = $m.Groups[1].Value.ToLowerInvariant()
    Assert-True ($hostName -match $allowedHosts) "$file names a host that is not a placeholder: $hostName"
  }
  foreach ($m in [regex]::Matches($text, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')) {
    Assert-True ($allowedGuids -contains $m.Value.ToLowerInvariant()) "$file contains a GUID that is not a placeholder: $($m.Value)"
  }
  if ($file -like '*.ps1') {
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
    Assert-True ($errors.Count -eq 0) "$file does not parse: $($errors | Select-Object -First 1)"
  }
}

foreach ($file in $scripts) {
  $path = Join-Path $here $file
  $help = Get-Help $path -Full
  Assert-True ([bool]"$($help.Synopsis)".Trim() -and "$($help.Synopsis)" -notmatch [regex]::Escape($file)) "$file has no synopsis"
  foreach ($p in @($help.parameters.parameter)) {
    if ($p.name -in 'WhatIf', 'Confirm') { continue }
    $hasDescription = $p.PSObject.Properties['description'] -and "$($p.description.Text)".Trim()
    Assert-True ([bool]$hasDescription) "$file parameter -$($p.name) has no help"
  }
  $cli = & pwsh -NoProfile -NonInteractive -File $path '-?' 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -eq 0 -and $cli -match 'SYNOPSIS') "pwsh -File $file -? failed"
}

# ---- -WhatIf calls nothing outside PowerShell ------------------------------
Reset-Mocks
$jaf = Join-Path $work 'journal-address.txt'
Set-Content -LiteralPath $jaf -Value ('journal-' + ('a' * 40) + '@standby.example.com') -Encoding ascii -NoNewline
$whatIfRuns = @(
  @('new-signin-app.ps1', @{ TenantId = $global:Mock_tenant; AppUrl = 'https://mail.example.com'; PagesProject = 'cmail-web'; WhatIf = $true }),
  @('set-bootstrap-secrets.ps1', @{ PagesProject = 'cmail-web'; AdminEmail = 'admin@example.com'; WhatIf = $true }),
  @('set-bootstrap-secrets.ps1', @{ PagesProject = 'cmail-web'; Remove = $true; WhatIf = $true }),
  @('new-sync-app.ps1', @{ TenantId = $global:Mock_tenant; MailDomain = 'example.com'; WranglerConfig = 'missing.toml'; DetectSharedMailboxes = $true; WhatIf = $true }),
  @('exchange-mirror.ps1', @{ StandbySubdomain = 'standby.example.com'; JournalAddressFile = $jaf; NdrAddress = 'journal-ndr@standby.example.com'; WhatIf = $true }),
  @('exchange-mirror.ps1', @{ StandbySubdomain = 'standby.example.com'; JournalAddressFile = $jaf; Rollback = $true; WhatIf = $true }),
  @('exchange-mirror.ps1', @{ StandbySubdomain = 'standby.example.com'; JournalAddressFile = (Join-Path $work 'new.txt'); NewJournalAddress = $true; WranglerConfig = 'missing.toml'; WhatIf = $true }),
  @('perms-setup.ps1', @{ TenantId = $global:Mock_tenant; Organization = 'example.onmicrosoft.com'; WranglerConfig = 'missing.toml'; WhatIf = $true }),
  @('perms-setup.ps1', @{ TenantId = $global:Mock_tenant; Organization = 'example.onmicrosoft.com'; WranglerConfig = 'missing.toml'; Rollback = $true; WhatIf = $true })
)
foreach ($run in $whatIfRuns) {
  try { $null = Invoke-Script $run[0] $run[1] } catch { $failures.Add("$($run[0]) -WhatIf threw: $_") }
}
Assert-True ($global:MockCalls.Count -eq 0) "-WhatIf made $($global:MockCalls.Count) outside call(s): $(($global:MockCalls | ForEach-Object { "$($_.Tool) $($_.Args)" }) -join '; ')"
Assert-True (-not (Test-Path (Join-Path $work 'new.txt'))) 'exchange-mirror -NewJournalAddress -WhatIf wrote a file'

# ---- Parameter validation ---------------------------------------------------
foreach ($bad in @(
  @('new-signin-app.ps1', @{ TenantId = 'not-a-guid'; AppUrl = 'https://mail.example.com'; PagesProject = 'p'; WhatIf = $true }),
  @('new-signin-app.ps1', @{ TenantId = $global:Mock_tenant; AppUrl = 'http://mail.example.com'; PagesProject = 'p'; WhatIf = $true }),
  @('new-signin-app.ps1', @{ TenantId = $global:Mock_tenant; AppUrl = 'https://mail.example.com/'; PagesProject = 'p'; WhatIf = $true }),
  @('new-sync-app.ps1', @{ TenantId = $global:Mock_tenant; MailDomain = 'Example.COM'; WranglerConfig = 'x'; WhatIf = $true }),
  @('exchange-mirror.ps1', @{ StandbySubdomain = 'standby.example.com'; JournalAddressFile = $jaf; WhatIf = $true }),
  @('perms-setup.ps1', @{ TenantId = $global:Mock_tenant; Organization = 'example.com'; WranglerConfig = 'x'; WhatIf = $true })
)) {
  $threw = $false
  try { $null = Invoke-Script $bad[0] $bad[1] } catch { $threw = $true }
  Assert-True $threw "$($bad[0]) accepted a bad value: $(($bad[1].Keys | Sort-Object | ForEach-Object { "$_=$($bad[1][$_])" }) -join ' ')"
}

# ---- Sign-in app: secret piped, never shown ---------------------------------
Reset-Mocks
$out = Invoke-Script 'new-signin-app.ps1' @{ TenantId = $global:Mock_tenant; AppUrl = 'https://mail.example.com'; PagesProject = 'cmail-web'; RepoRoot = $work }
$create = @(Get-CallsOf 'az' | Where-Object Args -Match '^ad app create')
Assert-True ($create.Count -eq 1 -and $create[0].Args -match 'AzureADMyOrg' -and $create[0].Args -match [regex]::Escape('--web-redirect-uris https://mail.example.com/auth/callback/microsoft')) 'sign-in app: not created single tenant with the callback URI'
$put = @(Get-CallsOf 'pnpm' | Where-Object Args -Match 'pages secret put MICROSOFT_CLIENT_SECRET --project-name cmail-web')
Assert-True ($put.Count -eq 1 -and $put[0].Stdin -eq $global:Mock_fakeSecret) 'sign-in app: client secret not piped to wrangler pages secret put'
$idPut = @(Get-CallsOf 'pnpm' | Where-Object Args -Match 'pages secret put MICROSOFT_CLIENT_ID')
Assert-True ($idPut.Count -eq 1 -and $idPut[0].Stdin -eq $global:Mock_newApp) 'sign-in app: client id not stored'
Assert-True ($out -notmatch [regex]::Escape($global:Mock_fakeSecret)) 'sign-in app: secret appeared in output'
Assert-True (-not (@(Get-CallsOf 'az') | Where-Object { $_.Args -match [regex]::Escape($global:Mock_fakeSecret) })) 'sign-in app: secret passed as an argument'

Reset-Mocks
$global:MockAzTenant = '00000000-0000-0000-0000-000000000009'
$threw = $false
try { $null = Invoke-Script 'new-signin-app.ps1' @{ TenantId = $global:Mock_tenant; AppUrl = 'https://mail.example.com'; PagesProject = 'cmail-web'; RepoRoot = $work } } catch { $threw = "$_" -match 'different tenant' }
Assert-True $threw 'sign-in app: did not stop on a different az tenant'
Assert-True (@(Get-CallsOf 'pnpm').Count -eq 0) 'sign-in app: stored something after the tenant check failed'
$global:MockAzTenant = $global:Mock_tenant

# ---- Bootstrap ----------------------------------------------------------------
Reset-Mocks
$out = Invoke-Script 'set-bootstrap-secrets.ps1' @{ PagesProject = 'cmail-web'; AdminEmail = 'admin@example.com'; RepoRoot = $work }
$tok = @(Get-CallsOf 'pnpm' | Where-Object Args -Match 'pages secret put BOOTSTRAP_ADMIN_TOKEN')
$clip = @(Get-CallsOf 'clipboard')
Assert-True ($tok.Count -eq 1 -and $tok[0].Stdin -match '^[A-Za-z0-9_-]{43}$') 'bootstrap: token not a 32-byte base64url value'
Assert-True ($clip.Count -eq 1 -and $tok.Count -eq 1 -and $clip[0].Stdin -eq $tok[0].Stdin) 'bootstrap: token not copied to the clipboard'
Assert-True ($tok.Count -eq 1 -and $out -notmatch [regex]::Escape($tok[0].Stdin)) 'bootstrap: token appeared in output'
Assert-True (@(Get-CallsOf 'pnpm' | Where-Object { $_.Args -match 'BOOTSTRAP_ADMIN_EMAIL' -and $_.Stdin -eq 'admin@example.com' }).Count -eq 1) 'bootstrap: admin email not stored'
Reset-Mocks
$null = Invoke-Script 'set-bootstrap-secrets.ps1' @{ PagesProject = 'cmail-web'; Remove = $true; RepoRoot = $work }
Assert-True (@(Get-CallsOf 'pnpm' | Where-Object Args -Match 'pages secret delete BOOTSTRAP_ADMIN_(TOKEN|EMAIL) --project-name cmail-web').Count -eq 2) 'bootstrap -Remove: both secrets not deleted'

# ---- Sync app -------------------------------------------------------------------
Reset-Mocks
$out = Invoke-Script 'new-sync-app.ps1' @{ TenantId = $global:Mock_tenant; MailDomain = 'example.com'; WranglerConfig = $wranglerToml; DetectSharedMailboxes = $true; ConsentWaitSeconds = 0; RepoRoot = $work }
$lookups = @(Get-CallsOf 'az' | Where-Object Args -Match '^ad sp show --id 00000003-0000-0000-c000-000000000000 --query appRoles')
Assert-True ($lookups.Count -eq 2 -and ($lookups.Args -join ' ') -match 'User\.Read\.All' -and ($lookups.Args -join ' ') -match 'MailboxSettings\.Read') 'sync app: permissions not User.Read.All + MailboxSettings.Read'
Assert-True (($lookups.Args -join ' ') -notmatch 'GroupMember') 'sync app: asked for GroupMember.Read.All without -GroupScoped'
Assert-True (@(Get-CallsOf 'az' | Where-Object Args -Match '^ad app permission admin-consent').Count -eq 1) 'sync app: no admin consent'
Assert-True (@(Get-CallsOf 'az' | Where-Object Args -Match "^rest --method GET --url https://graph.microsoft.com/v1.0/servicePrincipals/$global:Mock_spId/appRoleAssignments").Count -ge 1) 'sync app: consent not verified'
$put = @(Get-CallsOf 'pnpm' | Where-Object Args -Match 'exec wrangler secret put M365_CLIENT_SECRET --config')
Assert-True ($put.Count -eq 1 -and $put[0].Stdin -eq $global:Mock_fakeSecret) 'sync app: secret not piped to the Worker'
Assert-True ($out -notmatch [regex]::Escape($global:Mock_fakeSecret)) 'sync app: secret appeared in output'
Assert-True ($out -match 'M365_DETECT_SHARED_MAILBOXES = "true"') 'sync app: next steps miss M365_DETECT_SHARED_MAILBOXES'

# ---- Exchange mirror --------------------------------------------------------------
$global:MockNdr = 'old-ndr@example.test'
$global:MockRule = $null
$global:MockRemote = $null
function Connect-ExchangeOnline { $global:MockCalls.Add([pscustomobject]@{ Tool = 'exo'; Args = "Connect $($args -join ' ')"; Stdin = '' }) }
function Disconnect-ExchangeOnline { }
function Get-TransportConfig { [pscustomobject]@{ JournalingReportNdrTo = $global:MockNdr } }
function Set-TransportConfig { param($JournalingReportNdrTo) $global:MockNdr = $JournalingReportNdrTo; $global:MockCalls.Add([pscustomobject]@{ Tool = 'exo'; Args = "Set-TransportConfig $JournalingReportNdrTo"; Stdin = '' }) }
function Get-RemoteDomain { $global:MockRemote }
function New-RemoteDomain { param($Name, $DomainName) $global:MockRemote = [pscustomobject]@{ Name = $Name; DomainName = $DomainName; TNEFEnabled = $null } }
function Set-RemoteDomain { param($Identity, $TNEFEnabled) $global:MockRemote.TNEFEnabled = $TNEFEnabled }
function Remove-RemoteDomain { $global:MockRemote = $null }
function Get-JournalRule { $global:MockRule }
function New-JournalRule { param($Name, $JournalEmailAddress, $Scope, $Enabled) $global:MockRule = [pscustomobject]@{ Name = $Name; JournalEmailAddress = $JournalEmailAddress; Scope = $Scope; Enabled = $Enabled } }
function Enable-JournalRule { $global:MockRule.Enabled = $true }
function Disable-JournalRule { $global:MockRule.Enabled = $false }
function Remove-JournalRule { $global:MockRule = $null }

Reset-Mocks
$newFile = Join-Path $work 'private' 'journal.txt'
$out = Invoke-Script 'exchange-mirror.ps1' @{ StandbySubdomain = 'standby.example.com'; JournalAddressFile = $newFile; NewJournalAddress = $true; WranglerConfig = $wranglerToml; RepoRoot = $work }
$addr = if (Test-Path $newFile) { (Get-Content -LiteralPath $newFile -Raw).Trim() } else { '' }
Assert-True ($addr -match '^journal-[0-9a-f]{40}@standby\.example\.com$') 'mirror: new journal address has the wrong shape'
$put = @(Get-CallsOf 'pnpm' | Where-Object Args -Match 'secret put M365_JOURNAL_ADDRESS')
Assert-True ($put.Count -eq 1 -and $addr -and $put[0].Stdin -eq $addr) 'mirror: journal address not piped to the Worker'
Assert-True (-not $addr -or $out -notmatch [regex]::Escape($addr)) 'mirror: journal address appeared in output'
$threw = $false
try { $null = Invoke-Script 'exchange-mirror.ps1' @{ StandbySubdomain = 'standby.example.com'; JournalAddressFile = $newFile; NewJournalAddress = $true; WranglerConfig = $wranglerToml; RepoRoot = $work } } catch { $threw = $true }
Assert-True $threw 'mirror: -NewJournalAddress overwrote an existing address file'

Reset-Mocks
$mirrorArgs = @{ StandbySubdomain = 'standby.example.com'; JournalAddressFile = $newFile; NdrAddress = 'journal-ndr@standby.example.com' }
$null = Invoke-Script 'exchange-mirror.ps1' $mirrorArgs
$state = "$newFile.ndr-before.txt"
Assert-True ((Test-Path $state) -and (Get-Content -LiteralPath $state -Raw) -eq 'old-ndr@example.test') 'mirror: previous NDR address not saved'
Assert-True ($global:MockNdr -eq 'journal-ndr@standby.example.com') 'mirror: NDR address not set'
Assert-True ($null -ne $global:MockRemote -and $global:MockRemote.TNEFEnabled -eq $false -and $global:MockRemote.DomainName -eq 'standby.example.com') 'mirror: remote domain not created with TNEF off'
Assert-True ($null -ne $global:MockRule -and $global:MockRule.Enabled -eq $false -and $global:MockRule.Scope -eq 'Global' -and $global:MockRule.JournalEmailAddress -eq $addr) 'mirror: journal rule not created disabled, global, to the journal address'
$null = Invoke-Script 'exchange-mirror.ps1' $mirrorArgs
Assert-True ((Get-Content -LiteralPath $state -Raw) -eq 'old-ndr@example.test') 'mirror: a rerun overwrote the saved NDR address'
$null = Invoke-Script 'exchange-mirror.ps1' @{ StandbySubdomain = 'standby.example.com'; JournalAddressFile = $newFile; Enable = $true; SkipDnsCheck = $true }
Assert-True ($global:MockRule.Enabled -eq $true) 'mirror: -Enable did not enable the rule'
$null = Invoke-Script 'exchange-mirror.ps1' @{ StandbySubdomain = 'standby.example.com'; JournalAddressFile = $newFile; Rollback = $true }
Assert-True ($null -eq $global:MockRule -and $null -eq $global:MockRemote -and $global:MockNdr -eq 'old-ndr@example.test') 'mirror: -Rollback did not remove the rule and remote domain and restore the NDR address'

# ---- Permission setup ---------------------------------------------------------------
$global:MockCanWrite = $false
$global:MockRoleEntries = @()
function Import-Module { param($Name) if ($Name -ne 'ExchangeOnlineManagement') { Microsoft.PowerShell.Core\Import-Module @args -Name $Name } }
function New-SelfSignedCertificate { [pscustomobject]@{ Thumbprint = 'TESTTHUMBPRINT'; NotAfter = (Get-Date).AddMonths(12) } }
function Export-Certificate { param($Cert, $FilePath) Set-Content -LiteralPath $FilePath -Value 'public' }
function Export-PfxCertificate { param($Cert, $FilePath, $Password) [IO.File]::WriteAllBytes($FilePath, [byte[]](1, 2, 3, 4)) }
function Get-OrganizationConfig { [pscustomobject]@{ IsDehydrated = $false } }
function Get-ManagementRole { if ($global:MockRoleEntries.Count) { [pscustomobject]@{ Name = 'role' } } }
function New-ManagementRole { $global:MockRoleEntries = @('Get-Mailbox', 'Get-MailboxPermission', 'Get-RecipientPermission', 'Get-Recipient', 'Get-User', 'Get-Group', 'Set-Mailbox') }
function Get-ManagementRoleEntry { $global:MockRoleEntries | ForEach-Object { [pscustomobject]@{ Name = $_ } } }
function Remove-ManagementRoleEntry { param($Identity) $n = ($Identity -split '\\')[-1]; $global:MockRoleEntries = @($global:MockRoleEntries | Where-Object { $_ -ne $n }) }
function Get-RoleGroup { }
function New-RoleGroup { $global:MockCalls.Add([pscustomobject]@{ Tool = 'exo'; Args = 'New-RoleGroup'; Stdin = '' }) }
function Get-ServicePrincipal { }
function New-ServicePrincipal { $global:MockCalls.Add([pscustomobject]@{ Tool = 'exo'; Args = 'New-ServicePrincipal'; Stdin = '' }) }
function Add-RoleGroupMember { }
function Get-EXOMailbox { [pscustomobject]@{ PrimarySmtpAddress = 'shared@example.test' } }
function Add-MailboxPermission { if (-not $global:MockCanWrite) { throw 'The term Add-MailboxPermission is not recognized' } }
function Get-EXOMailboxPermission { [pscustomobject]@{ User = 'person@example.test'; IsInherited = $false } }

$permsArgs = @{ TenantId = $global:Mock_tenant; Organization = 'example.onmicrosoft.com'; WranglerConfig = $wranglerToml; WorkDir = (Join-Path $work 'perms'); PropagationWaitSeconds = 0; RepoRoot = $work }
Reset-Mocks
$out = Invoke-Script 'perms-setup.ps1' $permsArgs
Assert-True (($global:MockRoleEntries | Sort-Object) -join ',' -eq 'Get-Group,Get-Mailbox,Get-MailboxPermission,Get-Recipient,Get-RecipientPermission,Get-User') 'perms: role not trimmed to the six read cmdlets'
Assert-True (@(Get-CallsOf 'az' | Where-Object Args -Match '^ad sp show --id 00000002-0000-0ff1-ce00-000000000000 --query appRoles.*Exchange\.ManageAsApp').Count -ge 1) 'perms: Exchange.ManageAsApp not requested'
$pfxPut = @(Get-CallsOf 'pnpm' | Where-Object Args -Match 'secret put M365_EXO_CERT_PFX_B64')
$pwPut = @(Get-CallsOf 'pnpm' | Where-Object Args -Match 'secret put M365_EXO_CERT_PASSWORD')
Assert-True ($pfxPut.Count -eq 1 -and $pfxPut[0].Stdin -eq 'AQIDBA==') 'perms: PFX not piped to the Worker'
Assert-True ($pwPut.Count -eq 1 -and $pwPut[0].Stdin -match '^[A-Za-z0-9_-]{32}$') 'perms: PFX password not piped to the Worker'
Assert-True ($pwPut.Count -eq 1 -and $out -notmatch [regex]::Escape($pwPut[0].Stdin)) 'perms: PFX password appeared in output'
Assert-True (-not (Get-ChildItem -Path (Join-Path $work 'perms') -Filter '*.pfx' -ErrorAction SilentlyContinue)) 'perms: PFX left on disk'
Assert-True (@(Get-CallsOf 'exo' | Where-Object Args -EQ 'New-ServicePrincipal').Count -eq 1) 'perms: Exchange service principal not created'

Reset-Mocks
$global:MockCanWrite = $true
$global:MockRoleEntries = @()
$threw = $false
try { $null = Invoke-Script 'perms-setup.ps1' $permsArgs } catch { $threw = "$_" -match 'NO-GO' }
Assert-True $threw 'perms: did not stop with NO-GO when the app can write'
Assert-True (@(Get-CallsOf 'pnpm').Count -eq 0) 'perms: stored secrets on a NO-GO'

# ---- PSScriptAnalyzer (optional) ------------------------------------------------------
if (Get-Module -ListAvailable PSScriptAnalyzer) {
  $issues = @(Invoke-ScriptAnalyzer -Path $here -Severity Warning, Error -ExcludeRule PSAvoidUsingConvertToSecureStringWithPlainText, PSUseShouldProcessForStateChangingFunctions, PSUseSingularNouns, PSUseBOMForUnicodeEncodedFile |
    Where-Object ScriptName -NE 'onboarding.Tests.ps1')
  foreach ($i in $issues) { $failures.Add("PSScriptAnalyzer: $($i.ScriptName):$($i.Line) $($i.RuleName) $($i.Message)") }
} else {
  Write-Output 'PSScriptAnalyzer not installed: skipped.'
}

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
if ($failures.Count) {
  $failures | ForEach-Object { Write-Output "FAIL: $_" }
  exit 1
}
Write-Output 'All onboarding script checks passed.'
exit 0
