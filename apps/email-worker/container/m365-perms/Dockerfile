# cmail shared mailbox access collector (docs/m365-mailbox-permissions.md).
# Read-only: PowerShell 7 + ExchangeOnlineManagement, one script.
#
# Versions are pinned exactly and checked at build time:
# - Ubuntu 24.04 LTS: a supported Linux for the module
#   (https://learn.microsoft.com/powershell/exchange/exchange-online-powershell-v2, "Linux support").
# - PowerShell 7.6.10 (7.6 LTS) from packages.microsoft.com. Module 3.10.0 and
#   later need PowerShell 7.6.0 or later (same page).
# - ExchangeOnlineManagement 3.11.1 (PowerShell Gallery, stable, 11 Nov 2026).
# To update: change the two ARGs, rebuild, rerun the harness and a dry run.
#
# The image holds no secret. The certificate reaches the script only through
# the environment of the one process the Durable Object runs (exec).
FROM ubuntu:24.04

ARG POWERSHELL_VERSION=7.6.10-1.deb
ARG EXO_MODULE_VERSION=3.11.1

ENV DEBIAN_FRONTEND=noninteractive \
    POWERSHELL_TELEMETRY_OPTOUT=1 \
    POWERSHELL_UPDATECHECK=Off \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    HOME=/tmp

# Microsoft's documented install route for Ubuntu 24.04
# (https://learn.microsoft.com/powershell/scripting/install/install-ubuntu), pinned.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && wget -q -O /tmp/packages-microsoft-prod.deb https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb \
 && dpkg -i /tmp/packages-microsoft-prod.deb \
 && rm /tmp/packages-microsoft-prod.deb \
 && apt-get update \
 && apt-get install -y --no-install-recommends "powershell=${POWERSHELL_VERSION}" \
 && apt-get purge -y wget \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# Exact module version, for all users; fail the build on any other version.
RUN pwsh -NoLogo -NoProfile -NonInteractive -Command " \
      \$ErrorActionPreference = 'Stop'; \
      Install-Module -Name ExchangeOnlineManagement -RequiredVersion '${EXO_MODULE_VERSION}' -Scope AllUsers -Force -AllowClobber; \
      \$found = @(Get-Module -ListAvailable -Name ExchangeOnlineManagement | ForEach-Object { \$_.Version.ToString() }); \
      if (\$found -notcontains '${EXO_MODULE_VERSION}') { throw 'ExchangeOnlineManagement version mismatch' }"

RUN useradd --system --uid 10001 --home-dir /tmp --shell /usr/sbin/nologin collector \
 && mkdir -p /opt/cmail
COPY collect.ps1 /opt/cmail/collect.ps1
RUN chmod 0444 /opt/cmail/collect.ps1

USER collector
WORKDIR /tmp
# The Durable Object starts the container with its own entrypoint and runs
# the script with exec(); this default only keeps a manual `docker run` idle.
CMD ["sleep", "1200"]
