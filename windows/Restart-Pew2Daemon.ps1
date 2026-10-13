<#
.SYNOPSIS
  Safely restart the pew2 daemon (scheduled task \dev.pew2.daemon) on Windows.

.DESCRIPTION
  Stopping only bun.exe can leave port 8787 stuck. Agents the daemon launches
  through .cmd shims (e.g. codex-acp and the MCP servers it starts) can outlive
  it holding an inherited copy of the listening socket, and the next daemon then
  fails with EADDRINUSE. This script stops the daemon, its descendants, and any
  orphaned pew2 agent trees, waits for the port to free, starts the task, and
  waits for /health. It fails loudly (exit 1) if any step does not complete.

.PARAMETER WhatIf
  List what would be stopped; change nothing.

.EXAMPLE
  pwsh -File windows\Restart-Pew2Daemon.ps1 -WhatIf
  pwsh -File windows\Restart-Pew2Daemon.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [int]$Port,
  [string]$TaskName = 'dev.pew2.daemon'
)
$ErrorActionPreference = 'Stop'

# The port the task actually starts the daemon on, so moving it (for example off
# a port a dead process still holds) never leaves this script watching the old one.
if (-not $Port) {
  $taskXml = schtasks /query /tn $TaskName /xml | Out-String
  $Port = if ($taskXml -match 'PEW2_PORT=(\d+)') { [int]$Matches[1] } else { 8787 }
}

# Command lines of agents pew2 launches (see %USERPROFILE%\.pew2\providers).
$AgentPattern = 'codex-acp|ggcoder-guard|ggcoder\\dist\\cli\.js"?\s+acp|claude-code-acp|opencode(\.cmd)?"?\s+acp|hermes"?\s+acp'

$all = @(Get-CimInstance Win32_Process)
$alive = @{}; foreach ($p in $all) { $alive[[int]$p.ProcessId] = $p }

# Windows reuses process IDs, so ParentProcessId alone can point at an unrelated
# process that took over the number after the real parent exited. A process is
# only treated as a child if it started no earlier than its parent.
function Get-RealParent($proc) {
  $parent = $alive[[int]$proc.ParentProcessId]
  if ($parent -and $parent.CreationDate -le $proc.CreationDate) { $parent } else { $null }
}

function Get-Tree([int[]]$roots) {
  # Plain hashtable: an [ordered] dictionary treats an integer index as a
  # position, not a key.
  $found = @{}
  $frontier = @($roots | Where-Object { $alive.ContainsKey($_) })
  while ($frontier.Count) {
    $next = @()
    foreach ($id in $frontier) {
      if ($found.ContainsKey($id)) { continue }
      $proc = $alive[$id]
      $found[$id] = $proc
      $next += @($all | Where-Object {
          $_.ParentProcessId -eq $id -and $_.CreationDate -ge $proc.CreationDate
        } | ForEach-Object { [int]$_.ProcessId })
    }
    $frontier = $next
  }
  @($found.Values)
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$daemonPid = if ($listener) { [int]$listener.OwningProcess } else { $null }
$daemonAlive = $daemonPid -and $alive.ContainsKey($daemonPid)

# The daemon and everything it started: agent sessions and the MCP servers those
# agents launched. Restarting the daemon ends those sessions.
$daemonTree = if ($daemonAlive) { Get-Tree @($daemonPid) } else { @() }
$inDaemonTree = @{}; foreach ($p in $daemonTree) { $inDaemonTree[[int]$p.ProcessId] = $true }

# Orphaned pew2 agents: an agent command line whose real parent is gone. These
# are what hold an inherited copy of the listening socket after a crash.
$orphanRoots = @($all | Where-Object {
    $_.CommandLine -match $AgentPattern -and -not $inDaemonTree.ContainsKey([int]$_.ProcessId) -and -not (Get-RealParent $_)
  } | ForEach-Object { [int]$_.ProcessId })
$orphanTree = @(Get-Tree $orphanRoots | Where-Object { -not $inDaemonTree.ContainsKey([int]$_.ProcessId) })

$targets = @($daemonTree) + @($orphanTree)

function Show-Group([string]$title, $procs) {
  Write-Host "$title ($($procs.Count))"
  foreach ($t in $procs) {
    $cmd = if ($t.CommandLine) { $t.CommandLine.Substring(0, [Math]::Min(100, $t.CommandLine.Length)) } else { '' }
    Write-Host ("  {0,6}  {1,-16} {2}" -f $t.ProcessId, $t.Name, $cmd)
  }
}
Write-Host "Port $Port listener: $(if ($daemonPid) { "PID $daemonPid" + $(if ($daemonAlive) { '' } else { ' (process gone: stuck socket)' }) } else { 'none' })"
Show-Group 'Daemon and the agent sessions it started' $daemonTree
Show-Group 'Orphaned pew2 agents (parent gone)' $orphanTree

if (-not $PSCmdlet.ShouldProcess("pew2 daemon on port $Port", 'Stop and restart')) { return }

# An agent installed through `npx` may be mid-download under the daemon. Stopping
# it then leaves a half-written npx cache, and that agent fails every start
# afterwards with ERR_MODULE_NOT_FOUND (seen 2026-10-13 with Claude Code). Wait
# for installers to finish; give up loudly rather than break the cache.
$InstallerPattern = 'postinstall|preinstall|node-gyp|npm-cli\.js"?\s+(install|i|ci)\b'
$installing = @()
for ($i = 0; $i -lt 24; $i++) {
  $installing = @(Get-CimInstance Win32_Process | Where-Object {
      $daemonTree.ProcessId -contains $_.ParentProcessId -or $daemonTree.ProcessId -contains $_.ProcessId
    } | Where-Object { $_.CommandLine -match $InstallerPattern })
  if (-not $installing.Count) { break }
  if ($i -eq 0) { Write-Host "Waiting for $($installing.Count) agent install(s) to finish before stopping..." }
  Start-Sleep -Seconds 5
}
if ($installing.Count) {
  Write-Error "An agent install is still running after 2 minutes (PID $($installing[0].ProcessId)). Nothing was stopped; try again shortly."
  exit 1
}

foreach ($t in $targets) { Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue }

$freed = $false
for ($i = 0; $i -lt 15; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { $freed = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $freed) {
  $holder = (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess
  Write-Error "Port $Port is still held by PID $holder after stopping the daemon. Nothing was restarted."
  exit 1
}
Write-Host "Port $Port released."

schtasks /run /tn $TaskName | Out-Null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null
    $new = (Get-NetTCPConnection -LocalPort $Port -State Listen).OwningProcess
    Write-Host "pew2 daemon healthy after ${i}s (PID $new)."
    exit 0
  } catch { }
}
Write-Error "Daemon did not become healthy within 30s. Check $env:USERPROFILE\.pew2\logs\daemon.error.log"
exit 1
