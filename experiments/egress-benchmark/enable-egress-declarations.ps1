# enable-egress-declarations.ps1
#
# Patches ONE dsh profile so the local-router plugin loads with
# sourceReadEgress: 'declarations'. Reversible, idempotent, and it verifies its own
# work rather than reporting success blindly.
#
# Run this from a NORMAL PowerShell terminal, not from inside a DSH session: patching
# the profile does nothing until DSH restarts, and a restart ends the session.
#
#   .\enable-egress-declarations.ps1                 # patch the 'web' profile
#   .\enable-egress-declarations.ps1 -Profile tauri  # patch the 'tauri' profile
#   .\enable-egress-declarations.ps1 -Revert         # restore the backup
#
# Exit codes: 0 = patched and verified
#             2 = already patched (no change made)
#             3 = reverted
#             1 = failed; nothing was changed, or the change was rolled back

[CmdletBinding()]
param(
  [ValidateSet('web', 'tauri')]
  [string]$Profile = 'web',

  [switch]$Revert
)

$ErrorActionPreference = 'Stop'

$repoRoot    = 'C:\Projects\DSHLaya'
$pluginDir   = Join-Path $repoRoot 'plugin'
$declRoot    = Join-Path $pluginDir 'dist'
$profileFile = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\cordis.patch.yml"
$backupFile  = "$profileFile.bak-egressbench"
$logFile     = Join-Path $env:USERPROFILE '.dsh\local-router\router-debug.log'

function Fail($msg) {
  Write-Host "FAIL: $msg" -ForegroundColor Red
  exit 1
}

Write-Host "=== egress declarations switch ===" -ForegroundColor Cyan
Write-Host "profile : $Profile"
Write-Host "file    : $profileFile"
Write-Host ""

# ---------------------------------------------------------------- revert path
if ($Revert) {
  if (-not (Test-Path $backupFile)) { Fail "no backup at $backupFile - nothing to revert" }
  Copy-Item $backupFile $profileFile -Force
  Write-Host "restored from backup." -ForegroundColor Green
  Write-Host "Restart DSH for the revert to take effect." -ForegroundColor Yellow
  exit 3
}

# ---------------------------------------------------------------- preconditions
if (-not (Test-Path $profileFile)) { Fail "profile patch not found: $profileFile" }
if (-not (Test-Path $pluginDir))   { Fail "plugin directory not found: $pluginDir" }

$otherName = 'web'
if ($Profile -eq 'web') { $otherName = 'tauri' }
$otherFile = Join-Path $env:USERPROFILE ".dsh\profiles\$otherName\cordis.patch.yml"
if ((Test-Path $otherFile) -and (Select-String -Path $otherFile -Pattern 'sourceReadEgress' -Quiet)) {
  Write-Host "WARNING: the '$otherName' profile already sets sourceReadEgress." -ForegroundColor Yellow
  Write-Host "         Two patched profiles make the arm ambiguous. Revert one first." -ForegroundColor Yellow
  Write-Host ""
}

# ---------------------------------------------------------------- idempotence
if (Select-String -Path $profileFile -Pattern 'sourceReadEgress' -Quiet) {
  Write-Host "already patched - no change made." -ForegroundColor Yellow
  Select-String -Path $profileFile -Pattern 'sourceReadEgress|declarationRoot' |
    ForEach-Object { Write-Host ("  L{0}: {1}" -f $_.LineNumber, $_.Line.Trim()) }
  Write-Host ""
  Write-Host "If the plugin is not serving declarations, DSH has not been restarted." -ForegroundColor Yellow
  exit 2
}

# ---------------------------------------------------------------- backup
Copy-Item $profileFile $backupFile -Force
Write-Host "backup written: $backupFile"

# ---------------------------------------------------------------- patch
# Insert the two keys immediately under the 'config:' line of the local-router entry,
# matching that entry's own indentation. Anchored to the real file shapes: the block
# opens with '- id: local-router' and closes at the next list entry or EOF.
$lines = [System.IO.File]::ReadAllLines($profileFile)
$out = New-Object 'System.Collections.Generic.List[string]'
$inBlock  = $false
$inserted = $false

foreach ($line in $lines) {
  if ((-not $inBlock) -and ($line -match '^\s*-\s*id:\s*local-router\s*$')) {
    $inBlock = $true
    $out.Add($line)
    continue
  }
  if ($inBlock -and (-not $inserted) -and ($line -match '^(\s*)config:\s*$')) {
    $indent = $Matches[1] + '  '
    $out.Add($line)
    $out.Add("$indent# ADDED FOR THE EGRESS BENCHMARK - delete these two lines (or run -Revert) to return to the source default.")
    $out.Add("$indent" + "sourceReadEgress: 'declarations'")
    $out.Add("$indent" + "declarationRoot: '$declRoot'")
    $inserted = $true
    continue
  }
  if ($inBlock -and ($line -match '^\s*-\s*id:')) { $inBlock = $false }
  $out.Add($line)
}

if (-not $inserted) {
  Fail "could not find a local-router entry with a 'config:' line - file left unchanged"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($profileFile, $out, $utf8NoBom)
Write-Host "patched." -ForegroundColor Green

# ---------------------------------------------------------------- verify placement
# Parsed with js-yaml, the same library DSH itself uses, so this checks the file the way
# the loader will read it rather than pattern-matching text. A missing parser is a
# FAILURE, not a skip: twice in this project a check has reported success because it
# never actually ran.
Write-Host ""
Write-Host "--- verifying the keys landed inside local-router.config ---"
$verifyB64 = 'Y29uc3QgZnMgPSByZXF1aXJlKCJmcyIpCmNvbnN0IHBhdGggPSBwcm9jZXNzLmFyZ3ZbMl0KbGV0IHlhbWwgPSBudWxsCmxldCB3aGVyZSA9ICIiCmNvbnN0IGNhbmRpZGF0ZXMgPSBbCiAgIkM6L1VzZXJzL0ppbS9BcHBEYXRhL1JvYW1pbmcvbnBtL25vZGVfbW9kdWxlcy9AZGVlcHNlZWstYWkvZHNoL25vZGVfbW9kdWxlcy9qcy15YW1sIiwKICAiQzovVXNlcnMvSmltL0FwcERhdGEvUm9hbWluZy9ucG0vbm9kZV9tb2R1bGVzL0BkZWVwc2Vlay1haS9kc2gvbm9kZV9tb2R1bGVzL3lhbWwiCl0KZm9yIChjb25zdCBjIG9mIGNhbmRpZGF0ZXMpIHsgdHJ5IHsgeWFtbCA9IHJlcXVpcmUoYyk7IHdoZXJlID0gYy5zcGxpdCgiL25vZGVfbW9kdWxlcy8iKS5wb3AoKTsgYnJlYWsgfSBjYXRjaCAoZSkge30gfQppZiAoIXlhbWwpIHsKICBjb25zb2xlLmxvZygiRkFJTEVEOiBubyBZQU1MIHBhcnNlciBhdmFpbGFibGUsIHNvIHRoZSBwYXRjaCBDQUNOT1QgYmUgdmVyaWZpZWQuIFJlZnVzaW5nIHRvIHJlcG9ydCBzdWNjZXNzLiIpCiAgcHJvY2Vzcy5leGl0KDEpCn0KY29uc29sZS5sb2coInBhcnNlcjoiLCB3aGVyZSkKY29uc3QgbG9hZCA9IHlhbWwubG9hZCA/IHlhbWwubG9hZCA6ICh5YW1sLmRlZmF1bHQgJiYgeWFtbC5kZWZhdWx0LmxvYWQpCmxldCBkb2MKdHJ5IHsgZG9jID0gbG9hZChmcy5yZWFkRmlsZVN5bmMocGF0aCwgInV0ZjgiKSkgfQpjYXRjaCAoZSkgeyBjb25zb2xlLmxvZygiUEFSU0UgRkFJTEVEOiIsIGUubWVzc2FnZSk7IHByb2Nlc3MuZXhpdCgxKSB9CmlmICghQXJyYXkuaXNBcnJheShkb2MpKSB7IGNvbnNvbGUubG9nKCJQQVJTRSBGQUlMRUQ6IHRvcCBsZXZlbCBpcyBub3QgYW4gYXJyYXkiKTsgcHJvY2Vzcy5leGl0KDEpIH0KY29uc3QgZW50cnkgPSBkb2MuZmluZChmdW5jdGlvbiAoZSkgeyByZXR1cm4gZSAmJiBlLmlkID09PSAibG9jYWwtcm91dGVyIiB9KQppZiAoIWVudHJ5KSB7IGNvbnNvbGUubG9nKCJQQVJTRSBGQUlMRUQ6IG5vIGxvY2FsLXJvdXRlciBlbnRyeSIpOyBwcm9jZXNzLmV4aXQoMSkgfQpjb25zdCBjID0gZW50cnkuY29uZmlnIHx8IHt9CmNvbnNvbGUubG9nKCJlbnRyaWVzIHBhcnNlZCAgICAgICAgICA6IiwgZG9jLmxlbmd0aCkKY29uc29sZS5sb2coImNvbmZpZy5zb3VyY2VSZWFkRWdyZXNzIDoiLCBjLnNvdXJjZVJlYWRFZ3Jlc3MpCmNvbnNvbGUubG9nKCJjb25maWcuZGVjbGFyYXRpb25Sb290ICA6IiwgYy5kZWNsYXJhdGlvblJvb3QpCmNvbnNvbGUubG9nKCJrZXlzIHByZXNlcnZlZCAgICAgICAgICA6IiwgT2JqZWN0LmtleXMoYykuam9pbigiLCAiKSkKaWYgKGMuc291cmNlUmVhZEVncmVzcyAhPT0gImRlY2xhcmF0aW9ucyIpIHsgY29uc29sZS5sb2coIkZBSUxFRDogc291cmNlUmVhZEVncmVzcyBkaWQgbm90IGxhbmQgaW4gbG9jYWwtcm91dGVyLmNvbmZpZyIpOyBwcm9jZXNzLmV4aXQoMSkgfQppZiAoIWMuZGVjbGFyYXRpb25Sb290KSB7IGNvbnNvbGUubG9nKCJGQUlMRUQ6IGRlY2xhcmF0aW9uUm9vdCBtaXNzaW5nIik7IHByb2Nlc3MuZXhpdCgxKSB9CmlmICghYy5sb2NhbFByb3ZpZGVyIHx8ICFjLmNsb3VkUHJvdmlkZXIpIHsgY29uc29sZS5sb2coIkZBSUxFRDogYW4gZXhpc3Rpbmcga2V5IHdhcyBsb3N0Iik7IHByb2Nlc3MuZXhpdCgxKSB9CmNvbnNvbGUubG9nKCJPSzogYm90aCBrZXlzIGFyZSBpbnNpZGUgbG9jYWwtcm91dGVyLmNvbmZpZyBhbmQgdGhlIG9yaWdpbmFsIGtleXMgc3Vydml2ZSIp'
$verifyJs = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($verifyB64))
$tmpJs = Join-Path $env:TEMP 'verify-egress-patch.cjs'
[System.IO.File]::WriteAllText($tmpJs, $verifyJs, (New-Object System.Text.UTF8Encoding($false)))
node $tmpJs $profileFile
if ($LASTEXITCODE -ne 0) {
  Copy-Item $backupFile $profileFile -Force
  Fail "verification failed - profile restored from backup"
}

# ---------------------------------------------------------------- freshen declarations
Write-Host ""
Write-Host "--- rebuilding declarations (a stale .d.ts is REFUSED, which looks like friction) ---"
Push-Location $pluginDir
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm run build failed - fix the build before measuring" }
  $skelB64 = 'Y29uc3QgeyBkZWNsYXJhdGlvblBhdGhGb3IgfSA9IHJlcXVpcmUoIi4vZGlzdC9ndWFyZC5qcyIpCmNvbnN0IGZzID0gcmVxdWlyZSgiZnMiKQpjb25zdCBwID0gZGVjbGFyYXRpb25QYXRoRm9yKCJwbHVnaW4vc3JjL2RlY2xhcmF0aW9uLWVncmVzcy50cyIsICJwbHVnaW4vZGlzdCIpCmNvbnNvbGUubG9nKCJza2VsZXRvbjoiLCBwLCAifCBleGlzdHM6IiwgZnMuZXhpc3RzU3luYyhwKSkKcHJvY2Vzcy5leGl0KGZzLmV4aXN0c1N5bmMocCkgPyAwIDogMSkK'
  $skelJs = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($skelB64))
  $tmpSkel = Join-Path $env:TEMP 'check-skeleton.cjs'
  [System.IO.File]::WriteAllText($tmpSkel, $skelJs, $utf8NoBom)
  node $tmpSkel
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "the declaration the control will serve does not exist" }
} finally {
  Pop-Location
}

# ---------------------------------------------------------------- next steps
$before = 0
if (Test-Path $logFile) { $before = (Get-Content $logFile | Measure-Object).Count }

Write-Host ""
Write-Host "=== DONE - the profile is patched, but NOT YET LIVE ===" -ForegroundColor Green
Write-Host ""
Write-Host "NEXT, in this order:" -ForegroundColor Cyan
Write-Host "  1. Close and reopen DSH. Plugin options are read once at registration, so this"
Write-Host "     patch does nothing until the process restarts."
Write-Host "  2. In the NEW session, before running any task, run the liveness gate. Compare"
Write-Host "     the log line count before and after a single read of a covered file:"
Write-Host ""
Write-Host "       logline before  ->  read plugin/src/declaration-egress.ts once  ->  logline after"
Write-Host "       count '=== SOURCE_DECLARATION_SERVED ===' ONLY between those two line numbers"
Write-Host ""
Write-Host "     Non-empty  => the arm is armed; run the three tasks."
Write-Host "     Empty      => STOP. That is the failure this gate exists to catch, and it"
Write-Host "                   happened once already. Confirm a PLUGIN_INIT line appears"
Write-Host "                   after the 'before' line number, which is what proves the"
Write-Host "                   restart actually re-registered the plugin."
Write-Host ""
Write-Host "  Log line count right now (a sanity reference): $before"
Write-Host ""
Write-Host "TO UNDO:  .\enable-egress-declarations.ps1 -Profile $Profile -Revert   (then restart DSH)"
exit 0
