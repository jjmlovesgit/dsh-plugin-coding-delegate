# egress-gate-check.ps1
#
# Tells you whether the declarations egress control actually mounted, by reading the plugin's
# own trace log. No console watching, no restart needed for the check itself.
#
# Run from anywhere:
#   powershell -File C:\Projects\DSHLaya\experiments\egress-benchmark\egress-gate-check.ps1

$ErrorActionPreference = 'Stop'

$log = Join-Path $env:USERPROFILE '.dsh\local-router\router-debug.log'
$profileFile = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'

Write-Host "=== egress gate check ===" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------- 1. is the profile patched?
Write-Host "1. PROFILE" -ForegroundColor Yellow
if (Test-Path $profileFile) {
  $hit = Select-String -Path $profileFile -Pattern 'sourceReadEgress|declarationRoot'
  if ($hit) {
    $hit | ForEach-Object { Write-Host ("   L{0}: {1}" -f $_.LineNumber, $_.Line.Trim()) }
  } else {
    Write-Host "   NOT PATCHED - no egress keys in $profileFile" -ForegroundColor Red
  }
} else {
  Write-Host "   profile not found: $profileFile" -ForegroundColor Red
}
Write-Host ""

if (-not (Test-Path $log)) { Write-Host "no trace log at $log" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 2. when did the plugin last init?
Write-Host "2. PLUGIN INITIALISATION" -ForegroundColor Yellow
$initLines = Select-String -Path $log -Pattern 'PLUGIN_INIT_ASYMMETRIC_ORCHESTRATOR'
if (-not $initLines) { Write-Host "   no PLUGIN_INIT found - the plugin never registered" -ForegroundColor Red; exit 1 }
$lastInit = ($initLines | Select-Object -Last 1)
Write-Host ("   last init at log line {0}" -f $lastInit.LineNumber)
Write-Host ("   {0}" -f $lastInit.Line.Trim())
Write-Host ""

# ---------------------------------------------------------------- 3. did the egress listener mount?
Write-Host "3. EGRESS LISTENER" -ForegroundColor Yellow
Write-Host "   (the plugin writes this to its own trace only when declarations mode is active)"
$egress = Select-String -Path $log -Pattern 'Source egress control registered'
if ($egress) {
  $last = ($egress | Select-Object -Last 1)
  Write-Host ("   FOUND at log line {0}" -f $last.LineNumber) -ForegroundColor Green
  Write-Host ("   {0}" -f $last.Line.Trim())
  if ($last.LineNumber -ge $lastInit.LineNumber) {
    Write-Host "   => mounted AFTER the last init: the control IS live" -ForegroundColor Green
  } else {
    Write-Host "   => mounted BEFORE the last init: STALE, from an earlier session" -ForegroundColor Yellow
  }
} else {
  Write-Host "   NOT FOUND anywhere in the log" -ForegroundColor Red
  Write-Host "   => the declarations listener has never mounted in this data directory" -ForegroundColor Red
}
Write-Host ""

# ---------------------------------------------------------------- 4. has it ever served a declaration?
Write-Host "4. DECLARATIONS SERVED" -ForegroundColor Yellow
$served = Select-String -Path $log -Pattern 'SOURCE_DECLARATION_SERVED'
if ($served) {
  $served | ForEach-Object { Write-Host ("   L{0}: {1}" -f $_.LineNumber, $_.Line.Trim()) }
  $newest = ($served | Select-Object -Last 1)
  if ($newest.LineNumber -ge $lastInit.LineNumber) {
    Write-Host "   => served since the last init: ARM IS ARMED" -ForegroundColor Green
  } else {
    Write-Host "   => all occurrences predate the last init: ARM IS NOT ARMED" -ForegroundColor Red
  }
} else {
  Write-Host "   none - no declaration has ever been served" -ForegroundColor Red
}
Write-Host ""

# ---------------------------------------------------------------- 5. reads since the last init
Write-Host "5. READS SINCE THE LAST INIT" -ForegroundColor Yellow
$afterInit = Get-Content $log | Select-Object -Skip $lastInit.LineNumber
$reads = ($afterInit | Select-String -Pattern '=== SOURCE_READ ===' | Measure-Object).Count
Write-Host ("   SOURCE_READ events after line {0}: {1}" -f $lastInit.LineNumber, $reads)
if ($reads -eq 0) {
  Write-Host "   no covered file has been read since the restart, so a missing" -ForegroundColor Yellow
  Write-Host "   SOURCE_DECLARATION_SERVED proves nothing yet. Read a .ts file, then re-run." -ForegroundColor Yellow
}
Write-Host ""

# ---------------------------------------------------------------- verdict
Write-Host "=== VERDICT ===" -ForegroundColor Cyan
$armed = ($served -and (($served | Select-Object -Last 1).LineNumber -ge $lastInit.LineNumber))
if ($armed) {
  Write-Host "ARMED - run the three tasks." -ForegroundColor Green
} elseif ($egress) {
  Write-Host "LISTENER MOUNTED but nothing served yet." -ForegroundColor Yellow
  Write-Host "Read plugin/src/declaration-egress.ts once, then re-run this script." -ForegroundColor Yellow
} else {
  Write-Host "NOT ARMED - the declarations listener is not registered." -ForegroundColor Red
  Write-Host "The profile is patched, so the plugin is not receiving the option." -ForegroundColor Red
  Write-Host "Report section 3 to the architect." -ForegroundColor Red
  exit 2
}
