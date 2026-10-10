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
Write-Host "   REMOVED. The plugin announces this listener with console.log, which goes to"
Write-Host "   stdout and NOT to router-debug.log, so it can never be found here. An earlier"
Write-Host "   version of this script grepped the log for it, always found nothing, and"
Write-Host "   reported 'never mounted' on hosts where the control was in fact live."
Write-Host "   Section 4 below is the real signal: a served declaration is traced."
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
  # No declaration has been served since the last init. That is consistent with THREE
  # different states, and this script cannot tell them apart by itself:
  #   (a) arm A is live            - the option is absent, reads return source
  #   (b) the plugin is NOT LOADED - no hooks at all, reads return source
  #   (c) arm B is live but nothing covered has been read yet
  # Section 5 discriminates: if reads happened and nothing was served, it is (a) or (b).
  Write-Host "NO DECLARATION SERVED since the last init." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "That is consistent with three states, and this script cannot separate them:" -ForegroundColor Yellow
  Write-Host "  (a) you are in arm A, the ungated default"
  Write-Host "  (b) the plugin is not loaded at all"
  Write-Host "  (c) you are in arm B, but no covered file has been read yet"
  Write-Host ""
  if ($reads -gt 0) {
    Write-Host ("Section 5 shows {0} read(s) after the init, so (c) is ruled out." -f $reads) -ForegroundColor Cyan
    Write-Host "A covered read returned content and nothing was served: you are in (a) or (b)." -ForegroundColor Cyan
    Write-Host "Read plugin/src/declaration-egress.ts and compare what you get:" -ForegroundColor Cyan
    Write-Host "  raw source    -> arm A  (the plugin is loaded, the option is off)"
    Write-Host "  type skeleton -> arm B  (re-run this script, section 4 should now show it)"
  } else {
    Write-Host "Section 5 shows no reads after the init, so nothing is proved yet." -ForegroundColor Cyan
    Write-Host "To settle it, read plugin/src/declaration-egress.ts and re-run." -ForegroundColor Cyan
  }
  exit 2
}
