#Requires -Version 7.2

<#
.SYNOPSIS
  Exchange Online side of the Stanchion Exchange mirror (journaling): undeliverable
  report address, a TNEF-off remote domain and one journal rule, created
  DISABLED. -Enable turns the rule on; -Rollback undoes all three.

.DESCRIPTION
  Step 10 of docs/onboarding-microsoft-365.md; the feature is docs/exchange-mirror.md.

  Modes (run them in this order, each after the step before it is checked):
  1. -NewJournalAddress: makes journal-<40 hex>@<StandbySubdomain>, writes it
     to -JournalAddressFile (refuses to overwrite) and pipes it into the email
     Worker secret M365_JOURNAL_ADDRESS. The address is the security boundary
     of the mirror: keep the file private. Then add ONE Cloudflare Email
     Routing rule for that literal address -> the Stanchion email Worker.
  2. (no switch): signs in to Exchange Online and
     - saves the current JournalingReportNdrTo to -StateFile (once: a rerun
       never overwrites the saved value), then sets it to -NdrAddress, which
       must be outside Exchange Online (Microsoft's rule);
     - creates remote domain -RemoteDomainName for -StandbySubdomain with
       TNEFEnabled $false, so originals arrive as MIME;
     - creates journal rule -RuleName (Scope Global, all users) to the journal
       address, DISABLED.
  3. -Enable: after Admin > Exchange mirror is switched on in Stanchion, enables
     the rule. Journaling then copies ALL mail from that moment.
  -Rollback: disables and removes the rule, removes the remote domain and
  restores the saved JournalingReportNdrTo.

  Needs: PowerShell 7, the ExchangeOnlineManagement module, an account with
  the Exchange "Journaling" permission (Exchange Administrator or Global
  Administrator, activated in PIM before you run it). After connecting, the
  script checks the cmdlets it needs are available and stops before any
  change if not. Every Exchange call stops on error. Mode 1 also needs pnpm install done
  in the repo and Wrangler signed in.

  Before mode 3, the standby subdomain's SPF TXT record must include
  include:spf.protection.outlook.com (see the guide), or every report is
  refused while M365_JOURNAL_REQUIRE_AUTH is "true".

.PARAMETER StandbySubdomain
  The domain the journal address and the NDR address live on, routed by
  Cloudflare Email Routing (for example standby.example.com).
.PARAMETER JournalAddressFile
  A private file holding the journal address (one line). Written by -NewJournalAddress.
.PARAMETER NdrAddress
  Setup mode only (required there). Where Exchange sends undeliverable journal
  reports; it must not be an Exchange Online mailbox. Use an address on
  StandbySubdomain with its own Email Routing rule that reaches a person (for
  example a Stanchion mailbox through its standby address, or Email Routing's
  "Send to an email" to a verified address outside Exchange Online).
.PARAMETER StateFile
  Where the previous JournalingReportNdrTo is saved for -Rollback. Default: <JournalAddressFile>.ndr-before.txt
.PARAMETER NewJournalAddress
  Mode 1: create the journal address file and the Worker secret M365_JOURNAL_ADDRESS. No Exchange sign-in.
.PARAMETER Enable
  Mode 3: enable the journal rule (after the mirror is on in Stanchion Admin).
.PARAMETER Rollback
  Remove the journal rule and remote domain and restore the saved undeliverable-report address.
.PARAMETER WranglerConfig
  The email Worker's wrangler.toml. Only for -NewJournalAddress.
.PARAMETER RuleName
  Journal rule name. Default 'cmail mirror'.
.PARAMETER RemoteDomainName
  Remote domain name. Default 'cmail standby'.
.PARAMETER UserPrincipalName
  Optional admin sign-in name for Connect-ExchangeOnline.
.PARAMETER ExchangeModuleVersion
  ExchangeOnlineManagement version to load (default: any installed).
.PARAMETER SkipDnsCheck
  Do not check the standby subdomain's SPF record before -Enable.
.PARAMETER RepoRoot
  The Stanchion checkout that has Wrangler installed. Defaults to this repository.

.EXAMPLE
  pwsh -File scripts/onboarding/exchange-mirror.ps1 -StandbySubdomain standby.example.com -JournalAddressFile ~/cmail-private/journal-address.txt -NewJournalAddress -WranglerConfig apps/email-worker/wrangler.toml
.EXAMPLE
  pwsh -File scripts/onboarding/exchange-mirror.ps1 -StandbySubdomain standby.example.com -JournalAddressFile ~/cmail-private/journal-address.txt -WhatIf
.EXAMPLE
  pwsh -File scripts/onboarding/exchange-mirror.ps1 -StandbySubdomain standby.example.com -JournalAddressFile ~/cmail-private/journal-address.txt -Rollback
#>
[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = 'Setup')]
param(
  [Parameter(Mandatory)][string]$StandbySubdomain,
  [Parameter(Mandatory)][string]$JournalAddressFile,
  [string]$NdrAddress = '',
  [string]$StateFile = '',
  [Parameter(ParameterSetName = 'NewAddress', Mandatory)][switch]$NewJournalAddress,
  [Parameter(ParameterSetName = 'NewAddress', Mandatory)][string]$WranglerConfig,
  [Parameter(ParameterSetName = 'Enable', Mandatory)][switch]$Enable,
  [Parameter(ParameterSetName = 'Rollback', Mandatory)][switch]$Rollback,
  [string]$RuleName = 'cmail mirror',
  [string]$RemoteDomainName = 'cmail standby',
  [string]$UserPrincipalName = '',
  [string]$ExchangeModuleVersion = '',
  [switch]$SkipDnsCheck,
  [string]$RepoRoot = ''
)

. (Join-Path $PSScriptRoot '_common.ps1')
Assert-DomainName $StandbySubdomain 'StandbySubdomain'
if ($PSCmdlet.ParameterSetName -eq 'Setup') {
  if ($NdrAddress -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'Setup needs -NdrAddress: a mailbox outside Exchange Online that a person reads.' }
  if ($NdrAddress.Split('@')[1] -ine $StandbySubdomain) {
    Write-Warning "NdrAddress is not on $StandbySubdomain. Journal reports use it as envelope MAIL FROM, so the SPF check (M365_JOURNAL_NDR_DOMAIN) only passes if its domain has include:spf.protection.outlook.com."
  }
}
if (-not $StateFile) { $StateFile = "$JournalAddressFile.ndr-before.txt" }
if (-not $RepoRoot) { $RepoRoot = Get-RepoRoot }
$dryRun = [bool]$WhatIfPreference
$addressPattern = '^journal-[0-9a-f]{32,}@' + [regex]::Escape($StandbySubdomain) + '$'

# ---- Mode 1: new journal address ------------------------------------------
if ($NewJournalAddress) {
  if (Test-Path -LiteralPath $JournalAddressFile) { throw "$JournalAddressFile already exists. To rotate the address, follow docs/exchange-mirror.md#how-to-rotate-the-journal-token." }
  if (-not $dryRun) { $WranglerConfig = Resolve-WranglerConfig $WranglerConfig }
  if ($PSCmdlet.ShouldProcess($JournalAddressFile, "write a new journal address on $StandbySubdomain and store it as Worker secret M365_JOURNAL_ADDRESS")) {
    $address = "journal-$(New-RandomHex 20)@$StandbySubdomain"
    $dir = Split-Path -Parent ([IO.Path]::GetFullPath($JournalAddressFile))
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    try {
      # Secret first, file second: a failed upload leaves no file, so a rerun starts clean.
      Set-WranglerSecret -Name M365_JOURNAL_ADDRESS -Value $address -WranglerConfig $WranglerConfig -RepoRoot $RepoRoot
      Set-Content -LiteralPath $JournalAddressFile -Value $address -Encoding ascii -NoNewline
      # Only the current user may read it.
      if ($IsWindows) { Invoke-Native -Command 'icacls' -Arguments @($JournalAddressFile, '/inheritance:r', '/grant:r', "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):F") -Label 'icacls on the journal address file' | Out-Null }
      else { Invoke-Native -Command 'chmod' -Arguments @('600', $JournalAddressFile) -Label 'chmod on the journal address file' | Out-Null }
    } finally { Remove-Variable address -ErrorAction SilentlyContinue }
  }
  Write-Step 'Next'
  Write-Note "1. Worker [vars]: M365_JOURNAL_NDR_DOMAIN = `"$StandbySubdomain`" (plus the other settings in docs/exchange-mirror.md); deploy the Worker."
  Write-Note "2. Cloudflare Email Routing on $StandbySubdomain`: one custom address rule for the address in $JournalAddressFile -> Send to a Worker -> the Stanchion email Worker."
  Write-Note "3. Add include:spf.protection.outlook.com to the SPF TXT record of $StandbySubdomain."
  Write-Note '4. Run this script without -NewJournalAddress.'
  return
}

# ---- Exchange modes -------------------------------------------------------
Assert-File $JournalAddressFile 'JournalAddressFile'
$journal = (Get-Content -LiteralPath $JournalAddressFile -Raw).Trim()
if ($journal -notmatch $addressPattern) { throw "$JournalAddressFile does not hold a journal-<hex>@$StandbySubdomain address." }
if ($NdrAddress -ieq $journal) { throw 'NdrAddress must differ from the journal address.' }

if ($dryRun) {
  Write-Note 'Dry run: no Exchange sign-in; showing what would change.'
} else {
  if ($ExchangeModuleVersion) { Import-ExchangeModule $ExchangeModuleVersion }
  elseif (-not (Get-Command Connect-ExchangeOnline -ErrorAction SilentlyContinue)) {
    throw 'ExchangeOnlineManagement is not installed. Run: Install-Module ExchangeOnlineManagement -Scope CurrentUser'
  }
  $connect = @{ ShowBanner = $false }
  if ($UserPrincipalName) { $connect.UserPrincipalName = $UserPrincipalName }
  Connect-ExchangeOnline @connect -ErrorAction Stop
  # Pre-flight before any change: the signed-in admin must hold the Exchange
  # journaling and transport permissions (Exchange Administrator, or Global
  # Administrator; activate PIM roles before connecting).
  $needed = if ($Rollback) { 'Get-JournalRule', 'Disable-JournalRule', 'Remove-JournalRule', 'Get-RemoteDomain', 'Remove-RemoteDomain', 'Set-TransportConfig' }
            elseif ($Enable) { 'Get-JournalRule', 'Enable-JournalRule' }
            else { 'Get-TransportConfig', 'Set-TransportConfig', 'Get-RemoteDomain', 'New-RemoteDomain', 'Set-RemoteDomain', 'Get-JournalRule', 'New-JournalRule' }
  $absent = @($needed | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
  if ($absent.Count) {
    Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
    throw "This Exchange sign-in cannot run: $($absent -join ', '). Activate Exchange Administrator (or Global Administrator) in PIM, wait a minute, then rerun. Nothing was changed."
  }
}

try {
  if ($Rollback) {
    Write-Step 'Rolling back the Exchange mirror'
    $rule = if ($dryRun) { $true } else { Get-ExoOrNull { Get-JournalRule -Identity $RuleName -ErrorAction Stop } }
    if ($rule -and $PSCmdlet.ShouldProcess("journal rule '$RuleName'", 'disable and remove')) {
      Disable-JournalRule -Identity $RuleName -Confirm:$false -ErrorAction Stop
      Remove-JournalRule -Identity $RuleName -Confirm:$false -ErrorAction Stop
      Write-Note 'Journal rule removed. Reports stop now.'
    }
    $remote = if ($dryRun) { $true } else { Get-ExoOrNull { Get-RemoteDomain -Identity $RemoteDomainName -ErrorAction Stop } }
    if ($remote -and $PSCmdlet.ShouldProcess("remote domain '$RemoteDomainName'", 'remove')) {
      Remove-RemoteDomain -Identity $RemoteDomainName -Confirm:$false -ErrorAction Stop
      Write-Note 'Remote domain removed.'
    }
    $before = if (Test-Path -LiteralPath $StateFile) { (Get-Content -LiteralPath $StateFile -Raw).Trim() } else { $null }
    $restoreTo = if ($before) { $before } else { '(empty)' }
    if ($PSCmdlet.ShouldProcess('JournalingReportNdrTo', "restore to $restoreTo")) {
      if ($before) { Set-TransportConfig -JournalingReportNdrTo $before -ErrorAction Stop }
      else {
        Write-Warning 'No saved value (it was empty, or the state file is missing). Trying to clear it; if Exchange refuses, set it to another mailbox outside Exchange Online.'
        Set-TransportConfig -JournalingReportNdrTo $null -ErrorAction Stop
      }
      Write-Note 'Undeliverable journal report address restored.'
    }
    Write-Step 'Next: Admin > Exchange mirror > Turn off in Stanchion; optionally delete the Cloudflare routing rule and M365_JOURNAL_ADDRESS.'
    return
  }

  if ($Enable) {
    if (-not $SkipDnsCheck -and -not $dryRun) {
      if (Get-Command Resolve-DnsName -ErrorAction SilentlyContinue) {
        $spf = @(Resolve-DnsName -Name $StandbySubdomain -Type TXT -ErrorAction SilentlyContinue | ForEach-Object { $_.Strings -join '' } | Where-Object { $_ -like 'v=spf1*' })
        if (-not ($spf -match 'include:spf\.protection\.outlook\.com')) {
          throw "The SPF record of $StandbySubdomain has no include:spf.protection.outlook.com. Add it first (or pass -SkipDnsCheck if you authenticate reports another way)."
        }
      } else { Write-Warning "Cannot check DNS here. Check by hand that $StandbySubdomain's SPF has include:spf.protection.outlook.com." }
    }
    if ($PSCmdlet.ShouldProcess("journal rule '$RuleName'", 'enable (journaling copies ALL mail from now on)')) {
      Enable-JournalRule -Identity $RuleName -Confirm:$false -ErrorAction Stop
      Write-Note (Get-JournalRule -Identity $RuleName -ErrorAction Stop | Select-Object Name, Enabled, Scope | Format-List | Out-String).Trim()
    }
    Write-Step 'Next: send a test message between two licensed users; Admin > Exchange mirror should show a last report time and "filed".'
    return
  }

  Write-Step "Exchange mirror setup (rule created DISABLED)"
  if ($PSCmdlet.ShouldProcess('JournalingReportNdrTo', "save current value to $StateFile, then set to $NdrAddress")) {
    if (-not (Test-Path -LiteralPath $StateFile)) {
      $current = [string](Get-TransportConfig -ErrorAction Stop).JournalingReportNdrTo
      Set-Content -LiteralPath $StateFile -Value $current -Encoding utf8NoBOM -NoNewline
      Write-Note "Saved the previous value to $StateFile."
    } else { Write-Note "$StateFile already exists; keeping the value saved the first time." }
    Set-TransportConfig -JournalingReportNdrTo $NdrAddress -ErrorAction Stop
  }
  if ($PSCmdlet.ShouldProcess("remote domain '$RemoteDomainName' ($StandbySubdomain)", 'create if missing, TNEFEnabled $false')) {
    if (-not (Get-ExoOrNull { Get-RemoteDomain -Identity $RemoteDomainName -ErrorAction Stop })) {
      New-RemoteDomain -Name $RemoteDomainName -DomainName $StandbySubdomain -ErrorAction Stop | Out-Null
    }
    Set-RemoteDomain -Identity $RemoteDomainName -TNEFEnabled $false -ErrorAction Stop
  }
  if ($PSCmdlet.ShouldProcess("journal rule '$RuleName'", 'create DISABLED, Scope Global, all users, to the journal address')) {
    $existing = Get-ExoOrNull { Get-JournalRule -Identity $RuleName -ErrorAction Stop }
    if (-not $existing) {
      New-JournalRule -Name $RuleName -JournalEmailAddress $journal -Scope Global -Enabled $false -ErrorAction Stop | Out-Null
    } elseif ([string]$existing.JournalEmailAddress -ine $journal) {
      Write-Warning "Journal rule '$RuleName' already exists and its address does not look like the one in the file. Check it by hand (docs/exchange-mirror.md#how-to-rotate-the-journal-token)."
    }
    Write-Note (Get-JournalRule -Identity $RuleName -ErrorAction Stop | Select-Object Name, Enabled, Scope | Format-List | Out-String).Trim()
  }
  Write-Step 'Next: Admin > Exchange mirror > Turn on in Stanchion, then run this script with -Enable.'
} finally {
  if (-not $dryRun) { Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue }
}
