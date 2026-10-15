<#
.SYNOPSIS
  Bind a published npm tarball to the Git tag it claims to come from, file by file.

.DESCRIPTION
  Downloads <Package>@<Version> from the registry, extracts it, and compares every published file
  against the blob recorded in <Tag> under the package's subtree (default `plugin/`). The comparison
  runs in BOTH directions:

    package -> tag   every published file must exist in the tag and hash identically
    tag -> package   every file the tag says the package ships must be present in the tarball

  The second direction is the one that is easy to leave out, and leaving it out means a tarball that
  omitted a file entirely would still report success -- the mismatch list would simply never mention it.

  `dist.shasum` and `dist.integrity` are printed but are NOT the binding. npm embeds timestamps when it
  packs, so an unpacked-and-repacked copy of identical content produces a different shasum. The blob
  comparison is the binding, because a Git object hash is a function of the bytes alone.

  This is deliberately not part of `npm run gate`: it needs the network, and the gate must run offline.

.PARAMETER Package
  Registry package name. Defaults to the plugin's published name.

.PARAMETER Version
  The published version to download, e.g. 0.5.3. Required.

.PARAMETER Tag
  The Git tag the artifact claims to come from, e.g. v0.5.3. Required.

.PARAMETER Subtree
  The directory in the repository the package is built from. Defaults to `plugin`.

.PARAMETER RepoRoot
  Repository to read the tag from. Defaults to the parent of this script's directory, resolved in the
  body rather than in the parameter default: `$PSScriptRoot` is empty at bind time under
  `powershell -File`, which is the invocation this script is meant to survive.

.PARAMETER Offline
  Skip the registry metadata cross-checks (`gitHead`, `fileCount`) and verify against Git alone.

.PARAMETER KeepScratch
  Leave the download and extraction directory in place for inspection.

.EXAMPLE
  ./scripts/verify-release-tarball.ps1 -Version 0.5.3 -Tag v0.5.3

.NOTES
  Encodes three traps paid for on this host:
    * `Resolve-Path -RelativeBasePath` does not exist in Windows PowerShell 5.1, so relative paths are
      computed by substring here.
    * npm writes its file list to stderr, and a native command's stderr inside a PowerShell pipeline
      raises NativeCommandError and abandons the script -- which is how a publish once failed with no
      visible reason. npm and tar therefore run through cmd.exe with their streams sent to a file.
    * a mismatch table is only as good as the directions it compares.
    * a pathspec after `--` is resolved against the working directory git is handed, so a RepoRoot that
      is inside the repository but not its root makes every path lookup miss. The first run of this
      script reported all 55 files as EXTRA_IN_PACKAGE for exactly that reason, which is why the
      repository is located by walking up to `.git` instead of by assuming a layout.
#>
[CmdletBinding()]
param(
  [string]$Package = 'dsh-plugin-coding-delegate',
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$Subtree = 'plugin',
  [string]$RepoRoot = '',
  [switch]$Offline,
  [switch]$KeepScratch
)

$ErrorActionPreference = 'Continue'

if (-not $RepoRoot) {
  $selfPath = $PSCommandPath
  if (-not $selfPath) { $selfPath = $MyInvocation.MyCommand.Path }
  $probe = if ($selfPath) { Split-Path -Parent $selfPath } else { (Get-Location).Path }
  # Walk up to the repository that contains this script rather than assuming it sits one level down:
  # a pathspec after `--` is resolved against the working directory git is given, so a RepoRoot that is
  # merely *inside* the repository turns every path lookup into a miss and reports the whole tarball as
  # extra. That is how this script failed its first run against the real 0.5.3 release.
  while ($probe -and -not (Test-Path -LiteralPath (Join-Path $probe '.git'))) {
    $parent = Split-Path -Parent $probe
    if (-not $parent -or $parent -eq $probe) { break }
    $probe = $parent
  }
  if ($probe -and (Test-Path -LiteralPath (Join-Path $probe '.git'))) { $RepoRoot = $probe }
  else { $RepoRoot = (Get-Location).Path }
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
  Write-Host "[FAIL] $RepoRoot is not a Git working tree; the tag cannot be read from it." -ForegroundColor Red
  exit 1
}

function Invoke-Captured {
  param([string]$WorkDir, [string]$CommandLine)
  $log = Join-Path $WorkDir ('cmd-' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.log')
  cmd /c "cd /d `"$WorkDir`" && $CommandLine > `"$log`" 2>&1"
  $code = $LASTEXITCODE
  $text = ''
  if (Test-Path -LiteralPath $log) { $text = (Get-Content -LiteralPath $log -Raw) }
  [pscustomobject]@{ ExitCode = $code; Output = $text }
}

function Invoke-Git {
  param([string[]]$Arguments)
  $out = & git -C $RepoRoot @Arguments
  [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = @($out) }
}

$failures = New-Object System.Collections.ArrayList
function Add-Failure { param([string]$Message) [void]$failures.Add($Message) }

Write-Host "=== release tarball verification ===" -ForegroundColor Cyan
Write-Host ("package   : {0}@{1}" -f $Package, $Version)
Write-Host ("tag       : {0}" -f $Tag)
Write-Host ("repo      : {0}" -f $RepoRoot)

$tagResolve = Invoke-Git @('rev-parse', "$Tag^{commit}")
if ($tagResolve.ExitCode -ne 0) {
  Write-Host "[FAIL] $Tag does not resolve to a commit in $RepoRoot" -ForegroundColor Red
  exit 1
}
$tagCommit = $tagResolve.Lines[0].Trim()
Write-Host ("tag commit: {0}" -f $tagCommit)

$registry = $null
if (-not $Offline) {
  $view = Invoke-Captured -WorkDir $env:TEMP -CommandLine "npm view $Package@$Version --json"
  if ($view.ExitCode -ne 0) {
    Add-Failure "npm view $Package@$Version failed: $($view.Output.Trim())"
  }
  else {
    try { $registry = $view.Output | ConvertFrom-Json }
    catch { Add-Failure "npm view $Package@$Version did not return JSON: $($_.Exception.Message)" }
  }
  if ($registry) {
    Write-Host ("registry  : gitHead {0}  fileCount {1}  shasum {2}" -f $registry.gitHead, $registry.dist.fileCount, $registry.dist.shasum)
    if ($registry.gitHead -and $registry.gitHead -ne $tagCommit) {
      Add-Failure "registry gitHead $($registry.gitHead) is not the commit $Tag resolves to ($tagCommit)"
    }
  }
}

$scratch = Join-Path $env:TEMP ("dsh-verify-{0}-{1}" -f $Version, [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $scratch | Out-Null

try {
  $pack = Invoke-Captured -WorkDir $scratch -CommandLine "npm pack $Package@$Version"
  if ($pack.ExitCode -ne 0) {
    Add-Failure "npm pack failed: $($pack.Output.Trim())"
  }

  $tgz = @(Get-ChildItem -LiteralPath $scratch -Filter *.tgz)
  if ($tgz.Count -eq 0) {
    Add-Failure "no tarball was produced in $scratch"
  }
  else {
    $untar = Invoke-Captured -WorkDir $scratch -CommandLine ("tar -xzf " + $tgz[0].Name)
    if ($untar.ExitCode -ne 0) { Add-Failure "tar -xzf failed: $($untar.Output.Trim())" }

    $extractedRoot = Join-Path $scratch 'package'
    if (-not (Test-Path -LiteralPath $extractedRoot)) {
      Add-Failure "the tarball did not extract a package/ directory"
    }
    else {
      $files = @(Get-ChildItem -LiteralPath $extractedRoot -Recurse -File)
      $published = @{}
      foreach ($file in $files) {
        $rel = $file.FullName.Substring($extractedRoot.Length + 1).Replace('\', '/')
        $published[$rel] = $true

        $blobResult = Invoke-Git @('hash-object', $file.FullName)
        if ($blobResult.ExitCode -ne 0) { Add-Failure "git hash-object failed for $rel"; continue }
        $blob = $blobResult.Lines[0].Trim()

        $tagLine = Invoke-Git @('ls-tree', '-r', $Tag, '--', "$Subtree/$rel")
        if ($tagLine.ExitCode -ne 0 -or $tagLine.Lines.Count -eq 0) {
          Add-Failure "EXTRA_IN_PACKAGE  $rel  blob=$blob"
          continue
        }
        $tagBlob = ($tagLine.Lines[0] -split "\s+")[2]
        if ($blob -ne $tagBlob) {
          Add-Failure "HASH_MISMATCH     $rel  pack=$blob  tag=$tagBlob"
        }
      }

      $manifestResult = Invoke-Git @('show', "${Tag}:$Subtree/package.json")
      $expected = New-Object System.Collections.ArrayList
      if ($manifestResult.ExitCode -ne 0) {
        Add-Failure "could not read $Subtree/package.json from $Tag"
      }
      else {
        $manifest = ($manifestResult.Lines -join "`n") | ConvertFrom-Json
        $entries = @($manifest.files) + 'package.json'
        foreach ($entry in $entries) {
          if (-not $entry) { continue }
          $tree = Invoke-Git @('ls-tree', '-r', '--name-only', $Tag, '--', "$Subtree/$entry")
          if ($tree.ExitCode -ne 0 -or @($tree.Lines).Count -eq 0) {
            Add-Failure "the tag does not contain $Subtree/$entry, which its files list declares"
            continue
          }
          foreach ($treePath in $tree.Lines) {
            $trimmed = "$treePath".Trim()
            if ($trimmed) { [void]$expected.Add($trimmed.Substring($Subtree.Length + 1)) }
          }
        }
      }

      foreach ($expectedPath in $expected) {
        if (-not $published.ContainsKey($expectedPath)) {
          Add-Failure "MISSING_FROM_PACKAGE $expectedPath"
        }
      }

      if ($registry -and $registry.dist.fileCount) {
        if ([int]$registry.dist.fileCount -ne $files.Count) {
          Add-Failure ("registry says {0} files, the tarball holds {1}" -f $registry.dist.fileCount, $files.Count)
        }
      }

      Write-Host ("published : {0} file(s)  ({1})" -f $files.Count, $tgz[0].Name)
      Write-Host ("expected  : {0} file(s) from {1}" -f $expected.Count, $Tag)
    }
  }
}
finally {
  if ($KeepScratch) {
    Write-Host ("scratch   : kept at {0}" -f $scratch)
  }
  else {
    Remove-Item -Recurse -Force -LiteralPath $scratch -ErrorAction SilentlyContinue
    Write-Host ("scratch   : removed ({0})" -f (-not (Test-Path -LiteralPath $scratch)))
  }
}

if ($failures.Count -eq 0) {
  Write-Host ("[VERIFIED] every published file matches {0} blob-for-blob, and {0} ships nothing the tarball lacks." -f $Tag) -ForegroundColor Green
  exit 0
}

Write-Host ("[FAIL] {0} integrity problem(s) between the registry artifact and {1}:" -f $failures.Count, $Tag) -ForegroundColor Red
foreach ($failure in $failures) { Write-Host ("  " + $failure) -ForegroundColor Red }
exit 1
