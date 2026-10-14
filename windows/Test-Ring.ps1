<#
.SYNOPSIS
  Make the phone ring on purpose and time it: send a test prompt from the pew2 app over adb, lock the
  phone, and wait for the ring screen.

.DESCRIPTION
  Start with the app open on a chat in a test project (pick the project and agent on the phone once).
  The script then:
    1. reads whether the phone is on Wi-Fi or mobile data (read only; it never changes phone settings),
    2. types a uniquely tagged prompt into that chat and sends it,
    3. locks the screen, so the app is in the background as it would be in a pocket,
    4. waits for the app to see the event ("turn finished" or "approval needed") and for the ring screen,
    5. lets it ring for a few seconds, then taps Close,
    6. optionally checks OrcaCoder V5 lists the chat under -Project (the chat landed in the right project).
  Phone logs are captured only while it runs. One line per run is appended to -ResultsFile.

  Finished: any agent; the prompt waits 20 s in a shell so there is time to lock.
  Approval: needs an agent that asks before writing files (Claude Code does; OrcaCoder V5 never asks).

.PARAMETER Serial
  adb serial of the phone (adb devices).

.PARAMETER Kind
  Finished (default) or Approval.

.PARAMETER Project
  The test chat's project folder. With -V5Discovery, the chat must be the newest one V5 lists there.

.PARAMETER V5Discovery
  OrcaCoder V5's packages\ggcoder\dist\core\project-discovery.js, for the project check.

.EXAMPLE
  pwsh -File windows\Test-Ring.ps1 -Serial <serial> -Project L:\pew2-ring-tests -V5Discovery <path>
  pwsh -File windows\Test-Ring.ps1 -Serial <serial> -Kind Approval
#>
param(
  [Parameter(Mandatory)][string]$Serial,
  [ValidateSet('Finished', 'Approval')][string]$Kind = 'Finished',
  [string]$Project,
  [string]$V5Discovery,
  [int]$TimeoutSec = 180,
  [int]$RingSec = 6,
  [string]$ResultsFile = (Join-Path $env:TEMP 'pew2-ring-tests.csv'),
  [string]$Adb = (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'),
  [string]$Package = 'io.github.kenkaiii.pew2'
)
$ErrorActionPreference = 'Stop'

function Invoke-Adb([string[]]$Arguments) {
  $out = & $Adb -s $Serial @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "adb $($Arguments -join ' ') failed: $out" }
  return ($out | Out-String)
}

# The centre of the on-screen element whose accessibility label (content-desc) or text is $Name.
function Find-Element([string]$Name) {
  $xml = Invoke-Adb @('exec-out', 'uiautomator', 'dump', '/dev/tty')
  $escaped = [regex]::Escape($Name)
  $node = [regex]::Match($xml, "<node[^>]*(?:content-desc|text)=`"$escaped`"[^>]*bounds=`"\[(\d+),(\d+)\]\[(\d+),(\d+)\]`"")
  if (-not $node.Success) { throw "'$Name' is not on screen. Open the app on the test chat first." }
  $x = ([int]$node.Groups[1].Value + [int]$node.Groups[3].Value) / 2
  $y = ([int]$node.Groups[2].Value + [int]$node.Groups[4].Value) / 2
  return @([int]$x, [int]$y)
}

function Get-PhoneTime([string]$Line) {
  # logcat -v time: "10-14 10:22:33.123 I/Tag( 123): ..."
  if ($Line -match '^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})') { return [datetime]::ParseExact($Matches[1], 'MM-dd HH:mm:ss.fff', $null) }
  return $null
}

if (-not (Test-Path $Adb)) { throw "adb not found at $Adb" }
if ((& $Adb devices) -notmatch [regex]::Escape($Serial)) { throw "Phone $Serial is not connected over USB (adb devices)." }

$wifi = Invoke-Adb @('shell', 'cmd', 'wifi', 'status')
$network = if ($wifi -match 'is connected to') { 'Wi-Fi' } else { 'mobile data' }
$id = 'rt-' + (Get-Date -Format 'MMdd-HHmmss')
$prompt = if ($Kind -eq 'Finished') {
  "Ring test $id. Run the PowerShell command Start-Sleep -Seconds 20 and then reply with the single word done."
} else {
  "Ring test $id. Create a file named $id.txt containing the word ok."
}
Write-Host "Ring test $id  ($Kind, phone on $network)"

$log = Join-Path $env:TEMP "pew2-ring-$id.log"
Invoke-Adb @('logcat', '-c') | Out-Null
$logcat = Start-Process -FilePath $Adb -PassThru -WindowStyle Hidden -RedirectStandardOutput $log `
  -ArgumentList @('-s', $Serial, 'logcat', '-v', 'time', '-s', 'ReactNativeJS:V', 'ActivityTaskManager:I', 'ActivityManager:I')
try {
  # Bring the app back on the chat it was showing, then type and send.
  Invoke-Adb @('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP') | Out-Null
  Invoke-Adb @('shell', 'am', 'start', '-n', "$Package/.MainActivity") | Out-Null
  Start-Sleep -Seconds 2
  $box = Find-Element 'Message'
  Invoke-Adb @('shell', 'input', 'tap', $box[0], $box[1]) | Out-Null
  Invoke-Adb @('shell', 'input', 'text', ($prompt -replace ' ', '%s')) | Out-Null
  $send = Find-Element 'Send message'
  Invoke-Adb @('shell', 'input', 'tap', $send[0], $send[1]) | Out-Null
  $sent = Get-Date
  Start-Sleep -Seconds 2
  Invoke-Adb @('shell', 'input', 'keyevent', 'KEYCODE_SLEEP') | Out-Null
  Write-Host "  sent and locked at $($sent.ToString('HH:mm:ss')); waiting for the ring..."

  $eventPattern = if ($Kind -eq 'Finished') { '\[pew2\] turn finished' } else { '\[pew2\] approval needed' }
  $eventLine = $null; $ringLine = $null
  $deadline = $sent.AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline -and -not $ringLine) {
    Start-Sleep -Milliseconds 500
    $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
    if (-not $eventLine) { $eventLine = $lines | Where-Object { $_ -match $eventPattern } | Select-Object -First 1 }
    if ($eventLine) { $ringLine = $lines | Where-Object { $_ -match 'RingActivity' } | Select-Object -First 1 }
  }

  $eventAt = if ($eventLine) { Get-PhoneTime $eventLine }
  $ringAt = if ($ringLine) { Get-PhoneTime $ringLine }
  $ringDelay = if ($eventAt -and $ringAt) { [math]::Round(($ringAt - $eventAt).TotalSeconds, 1) }
  $rang = [bool]$ringLine
  if ($rang) {
    Write-Host "  RANG: event seen, ring screen up $ringDelay s later. Ringing for $RingSec s..."
    Start-Sleep -Seconds $RingSec
    $close = Find-Element 'Close'
    Invoke-Adb @('shell', 'input', 'tap', $close[0], $close[1]) | Out-Null
  } elseif ($eventLine) {
    Write-Host "  NO RING: the app saw the event but no ring screen opened within $TimeoutSec s." -ForegroundColor Red
  } else {
    Write-Host "  NO RING: the app never saw the event within $TimeoutSec s." -ForegroundColor Red
  }

  $filed = ''
  if ($Project -and $V5Discovery) {
    $check = Join-Path $env:TEMP "pew2-ring-check-$id.mjs"
    @'
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
const [, , discovery, project, id] = process.argv;
const { listRecentSessions } = await import(pathToFileURL(discovery).href);
const sessions = await listRecentSessions(project, 5, path.join(os.homedir(), ".orcacoder-v4", "sessions"));
const newest = JSON.stringify(sessions[0] ?? {});
console.log(newest.includes(id) ? "yes" : "no");
'@ | Set-Content -Path $check -Encoding utf8
    try { $filed = (& node $check $V5Discovery $Project $id | Out-String).Trim() } finally { Remove-Item $check }
    Write-Host "  Filed under $Project in V5: $filed"
  }

  if (-not (Test-Path $ResultsFile)) { 'id,kind,network,rang,ringDelaySec,filedInV5,log' | Set-Content $ResultsFile }
  "$id,$Kind,$network,$rang,$ringDelay,$filed,$log" | Add-Content $ResultsFile
  if (-not $rang) { exit 1 }
} finally {
  Stop-Process -Id $logcat.Id -ErrorAction SilentlyContinue
}
