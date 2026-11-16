#Requires -Version 7.2

<#
  Shared helpers for the scripts in scripts/onboarding. Dot-sourced, never run
  on its own. docs/onboarding-microsoft-365.md

  Rules every helper keeps:
  - stop on the first error (a native command's non-zero exit throws);
  - a secret is only ever held in a variable and piped to Wrangler's stdin:
    never an argument, never printed, never written to a file;
  - nothing here knows a real tenant, domain or account: every value comes
    from the calling script's parameters.
#>

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# Well-known Microsoft first-party application ids (the same in every tenant).
$script:GraphResourceAppId = '00000003-0000-0000-c000-000000000000'    # Microsoft Graph
$script:ExchangeResourceAppId = '00000002-0000-0ff1-ce00-000000000000' # Office 365 Exchange Online

function Write-Step([string]$Message) {
  Write-Information "==> $Message" -InformationAction Continue
}

function Write-Note([string]$Message) {
  Write-Information "    $Message" -InformationAction Continue
}

function Get-RepoRoot {
  (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
}

function Assert-Guid([string]$Value, [string]$Name) {
  $parsed = [guid]::Empty
  if (-not [guid]::TryParse($Value, [ref]$parsed) -or $Value -notmatch '^[0-9a-fA-F-]{36}$') {
    throw "$Name must be a GUID like 00000000-0000-0000-0000-000000000000."
  }
}

function Assert-DomainName([string]$Value, [string]$Name) {
  if ($Value -cnotmatch '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$') {
    throw "$Name must be a lower-case DNS name like example.com (got an invalid value)."
  }
}

function Assert-HttpsOrigin([string]$Value, [string]$Name) {
  $uri = $null
  if (-not [uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or
      $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or $Value.EndsWith('/')) {
    throw "$Name must be an https origin with no path or trailing slash, like https://mail.example.com."
  }
}

function Assert-File([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Name not found: $Path" }
}

# Runs a native command; throws on a non-zero exit. The error names only the
# first words of the command, so an argument can never leak into a log.
function Invoke-Native {
  param([Parameter(Mandatory)][string]$Command, [string[]]$Arguments = @(), [string]$Label = '')
  $output = & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    $what = if ($Label) { $Label } else { "$Command $(@($Arguments | Select-Object -First 3) -join ' ')" }
    throw "$what failed (exit code $LASTEXITCODE)."
  }
  $output
}

# A simple function (no param block) so az's own switches such as -o reach az
# untouched instead of being read as PowerShell common parameters.
function Invoke-Az {
  Invoke-Native -Command 'az' -Arguments ([string[]]$args)
}

# First non-empty line of a native command's output, trimmed; '' when none.
function Get-FirstLine([object[]]$Lines) {
  foreach ($line in @($Lines)) { if ("$line".Trim()) { return "$line".Trim() } }
  ''
}

function Assert-AzTenant([string]$TenantId) {
  if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI (az) not found. Install it, then run: az login --tenant <tenant id>'
  }
  $current = (Invoke-Az account show --query tenantId -o tsv | Out-String).Trim()
  if ($current -ne $TenantId) {
    throw "Azure CLI is signed in to a different tenant. Run: az login --tenant $TenantId --allow-no-subscriptions"
  }
}

# The id of a permission published by a Microsoft resource app, looked up in
# the tenant rather than hard-coded. Kind: Role (application) or Scope (delegated).
function Get-ResourcePermissionId {
  param([string]$ResourceAppId, [string]$Value, [ValidateSet('Role', 'Scope')][string]$Kind)
  $collection = if ($Kind -eq 'Role') { 'appRoles' } else { 'oauth2PermissionScopes' }
  $id = Get-FirstLine (Invoke-Az ad sp show --id $ResourceAppId --query "$collection[?value=='$Value'].id" -o tsv)
  Assert-Guid $id "Permission id for $Value"
  $id
}

function Find-EntraApp([string]$DisplayName) {
  $ids = @(Invoke-Az ad app list --display-name $DisplayName --query '[].appId' -o tsv | Where-Object { $_ })
  if ($ids.Count -gt 1) { throw "More than one Entra app is named '$DisplayName'. Pass -AppId to pick one." }
  if ($ids.Count -eq 1) { return ([string]$ids[0]).Trim() }
  ''
}

# Writes a requiredResourceAccess JSON file for az (it takes a file path).
function New-ResourceAccessFile {
  param([string]$ResourceAppId, [string[]]$PermissionIds, [ValidateSet('Role', 'Scope')][string]$Kind)
  $body = @(@{ resourceAppId = $ResourceAppId; resourceAccess = @($PermissionIds | ForEach-Object { @{ id = $_; type = $Kind } }) })
  $file = Join-Path ([IO.Path]::GetTempPath()) ("cmail-rra-{0}.json" -f [guid]::NewGuid().ToString('N'))
  ConvertTo-Json -InputObject $body -Depth 5 | Set-Content -LiteralPath $file -Encoding utf8NoBOM
  $file
}

# Active Entra directory roles of the signed-in az user. PIM roles count only
# once activated, and az must sign in again after activation (its token carries
# the roles it had at sign-in).
function Get-ActiveDirectoryRoles {
  @(Invoke-Az rest --method GET --url 'https://graph.microsoft.com/v1.0/me/transitiveMemberOf/microsoft.graph.directoryRole?$select=displayName' --query 'value[].displayName' -o tsv |
    Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() })
}

# Pre-flight, before anything is created. Need:
#   AppRegistration - create apps and grant delegated consent: Global Administrator,
#                     Application Administrator or Cloud Application Administrator;
#   AppRoleConsent  - consent to application permissions (app roles): Global
#                     Administrator, or Privileged Role Administrator plus
#                     (Cloud) Application Administrator;
#   Exchange        - Exchange Administrator or Global Administrator.
function Assert-AdminRoles {
  param([ValidateSet('AppRegistration', 'AppRoleConsent', 'Exchange')][string[]]$Need)
  $roles = @(Get-ActiveDirectoryRoles)
  $ga = $roles -contains 'Global Administrator'
  $appAdmin = ($roles -contains 'Application Administrator') -or ($roles -contains 'Cloud Application Administrator')
  $problems = @()
  if ($Need -contains 'AppRegistration' -and -not ($ga -or $appAdmin)) { $problems += 'Application Administrator (or Global Administrator)' }
  if ($Need -contains 'AppRoleConsent' -and -not ($ga -or (($roles -contains 'Privileged Role Administrator') -and $appAdmin))) {
    $problems += 'Global Administrator, or Privileged Role Administrator plus Application Administrator'
  }
  if ($Need -contains 'Exchange' -and -not ($ga -or ($roles -contains 'Exchange Administrator'))) { $problems += 'Exchange Administrator (or Global Administrator)' }
  if ($problems.Count) {
    $active = if ($roles.Count) { $roles -join ', ' } else { 'none' }
    throw "Missing active role: $($problems -join '; '). Activate it in PIM (Entra > Privileged Identity Management > My roles), wait a minute, run 'az login' again, then rerun. Active now: $active."
  }
}

# Makes sure the service principal holds each application permission (app role)
# of the resource. `az ad app permission admin-consent` is tried first; it has
# been seen NOT to apply an app role on a live tenant, so anything still missing
# is then granted directly with an appRoleAssignment (POST appRoleAssignedTo),
# and the result is read back.
function Grant-AppRoles {
  param([string]$AppId, [string]$ServicePrincipalId, [string]$ResourceAppId, [string[]]$RoleIds, [int]$WaitSeconds = 30)
  try { Invoke-Az ad app permission admin-consent --id $AppId | Out-Null }
  catch { Write-Warning "admin-consent did not complete ($_); granting directly." }
  $url = "https://graph.microsoft.com/v1.0/servicePrincipals/$ServicePrincipalId/appRoleAssignments"
  $readGranted = { @(Invoke-Az rest --method GET --url $url --query 'value[].appRoleId' -o tsv | Where-Object { $_ } | ForEach-Object { ([string]$_).Trim() }) }
  $deadline = (Get-Date).AddSeconds([Math]::Max($WaitSeconds, 0))
  while ($true) {
    $granted = & $readGranted
    $missing = @($RoleIds | Where-Object { $granted -notcontains $_ })
    if ($missing.Count -eq 0 -or (Get-Date) -ge $deadline) { break }
    Start-Sleep -Seconds 10
  }
  if ($missing.Count) {
    $resourceSpId = Get-FirstLine (Invoke-Az ad sp show --id $ResourceAppId --query id -o tsv)
    Assert-Guid $resourceSpId 'Resource service principal id'
    foreach ($roleId in $missing) {
      $bodyFile = Join-Path ([IO.Path]::GetTempPath()) ("cmail-ara-{0}.json" -f [guid]::NewGuid().ToString('N'))
      ConvertTo-Json -InputObject @{ principalId = $ServicePrincipalId; resourceId = $resourceSpId; appRoleId = $roleId } |
        Set-Content -LiteralPath $bodyFile -Encoding utf8NoBOM
      try {
        Invoke-Az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$resourceSpId/appRoleAssignedTo" --body "@$bodyFile" --headers 'Content-Type=application/json' | Out-Null
      } finally { Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue }
    }
    $granted = & $readGranted
    $still = @($RoleIds | Where-Object { $granted -notcontains $_ })
    if ($still.Count) { throw "$($still.Count) application permission(s) are still not granted. Check Entra > Enterprise applications > the app > Permissions." }
    Write-Note "Granted $($missing.Count) application permission(s) directly (admin-consent had not applied them)."
  }
}

# Tenant-wide (AllPrincipals) consent for delegated scopes, checked on the
# service principal's oauth2PermissionGrants. `az ad app permission
# admin-consent` is tried first; scopes still missing are granted directly
# (POST oauth2PermissionGrants), then read back.
function Grant-DelegatedScopes {
  param([string]$AppId, [string]$ServicePrincipalId, [string]$ResourceAppId, [string[]]$Scopes)
  try { Invoke-Az ad app permission admin-consent --id $AppId | Out-Null }
  catch { Write-Warning "admin-consent did not complete ($_); granting directly." }
  $readGranted = {
    @(Invoke-Az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$ServicePrincipalId/oauth2PermissionGrants" --query "value[?consentType=='AllPrincipals'].scope" -o tsv |
      ForEach-Object { "$_" -split '\s+' } | Where-Object { $_ })
  }
  $missing = @($Scopes | Where-Object { (& $readGranted) -notcontains $_ })
  if ($missing.Count -eq 0) { return }
  $resourceSpId = Get-FirstLine (Invoke-Az ad sp show --id $ResourceAppId --query id -o tsv)
  Assert-Guid $resourceSpId 'Resource service principal id'
  $bodyFile = Join-Path ([IO.Path]::GetTempPath()) ("cmail-grant-{0}.json" -f [guid]::NewGuid().ToString('N'))
  ConvertTo-Json -InputObject @{ clientId = $ServicePrincipalId; consentType = 'AllPrincipals'; resourceId = $resourceSpId; scope = ($Scopes -join ' ') } |
    Set-Content -LiteralPath $bodyFile -Encoding utf8NoBOM
  try {
    Invoke-Az rest --method POST --url 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants' --body "@$bodyFile" --headers 'Content-Type=application/json' | Out-Null
  } finally { Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue }
  $still = @($Scopes | Where-Object { (& $readGranted) -notcontains $_ })
  if ($still.Count) { throw "Admin consent is still missing for: $($still -join ', '). Grant it in Entra > App registrations > the app > API permissions." }
  Write-Note "Granted $($missing -join ', ') directly (admin-consent had not applied them)."
}

# Runs an Exchange Get-* query (which must use -ErrorAction Stop); returns
# $null only when the object does not exist. Any other error (sign-in,
# permission, throttling) stops the script.
function Get-ExoOrNull([scriptblock]$Query) {
  try { & $Query }
  catch {
    if ("$_" -match "couldn't be found|could not be found|wasn't found|was not found|ManagementObjectNotFound") { return $null }
    throw
  }
}

function New-RandomToken([int]$Bytes = 32) {
  [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomHex([int]$Bytes = 20) {
  [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)).ToLowerInvariant()
}

# Pipes a value into `wrangler secret put` (Worker) or `wrangler pages secret put`
# (Pages). The value goes to stdin only; Wrangler's own output is shown only on
# failure (it never echoes the value).
function Set-WranglerSecret {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Value,
    [string]$WranglerConfig = '',
    [string]$PagesProject = '',
    [string]$RepoRoot = (Get-RepoRoot)
  )
  if (-not $Value) { throw "Refusing to store an empty value in $Name." }
  $wranglerArgs = if ($PagesProject) { @('exec', 'wrangler', 'pages', 'secret', 'put', $Name, '--project-name', $PagesProject) }
                  else { @('exec', 'wrangler', 'secret', 'put', $Name, '--config', $WranglerConfig) }
  # --env= targets the top-level (production) environment, never [env.preview].
  $wranglerArgs += '--env='
  Push-Location $RepoRoot
  try {
    $out = $Value | & pnpm @wranglerArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
      $out | Select-Object -Last 8 | ForEach-Object { Write-Warning "$_" }
      throw "wrangler could not store $Name (exit code $LASTEXITCODE)."
    }
  } finally { Pop-Location }
  Write-Note "Stored $Name (value not shown)."
}

# Deletes a secret; one that is already gone counts as done.
function Remove-WranglerSecret {
  param([Parameter(Mandatory)][string]$Name, [string]$WranglerConfig = '', [string]$PagesProject = '', [string]$RepoRoot = (Get-RepoRoot))
  $wranglerArgs = if ($PagesProject) { @('exec', 'wrangler', 'pages', 'secret', 'delete', $Name, '--project-name', $PagesProject) }
                  else { @('exec', 'wrangler', 'secret', 'delete', $Name, '--config', $WranglerConfig) }
  $wranglerArgs += '--env='
  Push-Location $RepoRoot
  try {
    # stdin is not a terminal, so Wrangler takes its default answer (yes) to "Are you sure?".
    $out = 'y' | & pnpm @wranglerArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
      if (($out | Out-String) -match '(?i)not found|does not exist|no such|10056') { Write-Note "$Name was already absent."; return }
      $out | Select-Object -Last 8 | ForEach-Object { Write-Warning "$_" }
      throw "wrangler could not delete $Name (exit code $LASTEXITCODE)."
    }
  } finally { Pop-Location }
  Write-Note "Deleted $Name."
}

function Resolve-WranglerConfig([string]$Path) {
  Assert-File $Path 'Wrangler config'
  (Resolve-Path -LiteralPath $Path).Path
}

function Import-ExchangeModule([string]$Version) {
  try { Import-Module -Name ExchangeOnlineManagement -RequiredVersion $Version -ErrorAction Stop }
  catch { throw "ExchangeOnlineManagement $Version is not installed. Run: Install-Module ExchangeOnlineManagement -RequiredVersion $Version -Scope CurrentUser" }
}
