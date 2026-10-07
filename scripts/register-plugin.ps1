[CmdletBinding()]
param(
    # Which DSH profile to register into. `web` is the CLI profile; the desktop app boots
    # `tauri`. Any profile name works:
    #   .\scripts\register-plugin.ps1 -Profile tauri
    [string]$Profile = "web"
)

# Registration for the DSH Local Router plugin.
#
# It writes exactly two things, both of which DSH actually reads:
#   1. the profile's package.json     -- lists the plugin in dsh.profile.bundles
#   2. the profile's cordis.patch.yml -- merges the plugin config and the provider entries
#
# It deliberately does NOT write ~/.dsh/settings.yaml or ~/.dsh/config.json.
#   * A `dsh-plugin-codeoffload:` section in settings.yaml is never merged into the plugin's
#     options -- only the profile patch is -- so it looks like configuration while doing
#     nothing.
#   * Nothing in the DSH runtime reads a `plugins` array from config.json.
# An earlier version of this script wrote both and reported success for both.
#
# It MERGES: it never overwrites either file wholesale, so settings you added by hand survive.

# BOM-less UTF-8 writer. PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, and
# JSON.parse rejects a BOM outright (it broke profile loading once).
function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

# The YAML payload of a patch file, with comments and blank lines removed, for detection only.
function Get-PatchBody([string]$Text) {
    ($Text -split "`r?`n" | Where-Object { $_.Trim() -and -not $_.TrimStart().StartsWith('#') }) -join "`n"
}

$ErrorActionPreference = "Stop"

$PluginName = "dsh-plugin-codeoffload"
# The id of the entry that the plugin's own bundle patch INSERTS. A config override must
# target this id: targeting the package name silently does nothing, which is the kind of
# failure that looks like the plugin ignoring your settings.
$PluginEntryId = "local-router"

$RootDir = Resolve-Path "$PSScriptRoot\.."
$PluginDir = Join-Path $RootDir "plugin"
$PluginDist = Join-Path $PluginDir "dist\index.js"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Registering the DSH Local Router plugin" -ForegroundColor Cyan
Write-Host " Profile: $Profile" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

if (-not (Test-Path $PluginDist)) {
    Write-Host "No build found; running npm run build first..." -ForegroundColor Yellow
    Push-Location $PluginDir
    npm run build
    Pop-Location
}

$UserDshDir = Join-Path $env:USERPROFILE ".dsh"
$ProfileDir = Join-Path $UserDshDir "profiles\$Profile"
if (-not (Test-Path $ProfileDir)) {
    Write-Host "Profile '$Profile' does not exist at:" -ForegroundColor Red
    Write-Host "  $ProfileDir" -ForegroundColor Red
    Write-Host "Boot it once (dsh --profile $Profile), then run this again." -ForegroundColor Red
    exit 1
}

# 1. Register the package into the profile
$dshCli = Get-Command "dsh" -ErrorAction SilentlyContinue
if ($dshCli) {
    Write-Host "[1/2] dsh plugin --profile $Profile add ..." -ForegroundColor Yellow
    try {
        & dsh plugin --profile $Profile add $PluginDir
    } catch {
        Write-Host "The CLI step reported: $($_.Exception.Message)" -ForegroundColor Yellow
    }
} else {
    Write-Host "[1/2] No 'dsh' on PATH; skipping the CLI step." -ForegroundColor Yellow
}

# 2. Make sure dsh.profile.bundles lists the plugin
$ProfilePkgFile = Join-Path $ProfileDir "package.json"
if (Test-Path $ProfilePkgFile) {
    try {
        $profilePkg = Get-Content $ProfilePkgFile -Raw | ConvertFrom-Json
        if ($profilePkg.dsh -and $profilePkg.dsh.profile -and $profilePkg.dsh.profile.bundles) {
            $bundles = @($profilePkg.dsh.profile.bundles)
            if ($bundles -notcontains $PluginName) {
                $profilePkg.dsh.profile.bundles = $bundles + $PluginName
                Write-Utf8NoBom $ProfilePkgFile ($profilePkg | ConvertTo-Json -Depth 5)
                Write-Host "      Added $PluginName to dsh.profile.bundles" -ForegroundColor Green
            } else {
                Write-Host "      $PluginName is already in dsh.profile.bundles" -ForegroundColor Yellow
            }
        } else {
            Write-Host "      package.json has no dsh.profile.bundles list; left untouched." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "      Could not update package.json: $($_.Exception.Message)" -ForegroundColor Yellow
    }
} else {
    Write-Host "      No package.json in the profile; left untouched." -ForegroundColor Yellow
}

# 3. Merge the plugin config and the provider entries into the profile patch
Write-Host "[2/2] Merging the profile patch..." -ForegroundColor Yellow
$PatchFile = Join-Path $ProfileDir "cordis.patch.yml"

$routerEntry = @"
- id: $PluginEntryId
  config:
    localProvider: 'lm-studio'
    localModel: 'qwen/qwen3.8-27b'
    cloudProvider: 'deepseek-official'
    cloudModel: 'deepseek-chat'
    # guardAskPaths REPLACES the built-in default (tests/, tools/), so list every path that
    # should stay approval-eligible rather than hard-denied.
    guardAskPaths:
      - 'tests/'
      - 'tools/'
    dlpAction: 'local'
"@

$providerEntries = @"
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      lm-studio:
        api: openai-completions
        baseURL: http://127.0.0.1:1234/v1
        apiKeyEnv: LM_STUDIO_API_KEY
        models:
          - id: qwen/qwen3.8-27b
            name: 'Qwen 3.8 27B Local'
            maxTokens: 16384

- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
"@

$existingPatch = ""
if (Test-Path $PatchFile) { $existingPatch = [System.IO.File]::ReadAllText($PatchFile) }
$body = Get-PatchBody $existingPatch

if ($body.Trim() -eq "[]") {
    # A fresh profile ships an empty array with advisory comments above it. Appending to `[]`
    # would produce invalid YAML, so replace the array and keep the comments.
    $replaced = [regex]::Replace($existingPatch, '(?m)^\[\]\s*$', ($routerEntry + "`n`n" + $providerEntries))
    Write-Utf8NoBom $PatchFile $replaced
    Write-Host "      Wrote the plugin config and provider entries" -ForegroundColor Green
}
elseif ($body.Trim() -eq "") {
    Write-Utf8NoBom $PatchFile (($routerEntry + "`n`n" + $providerEntries) + "`n")
    Write-Host "      Created cordis.patch.yml" -ForegroundColor Green
}
else {
    $missing = @()
    if ($body -notmatch ("(?m)^- id: " + [regex]::Escape($PluginEntryId) + "\s*$")) { $missing += $routerEntry }
    if ($body -notmatch '(?m)^- id: llm-pi-ai\s*$') { $missing += $providerEntries }

    if ($missing.Count -eq 0) {
        Write-Host "      Already configures the plugin and providers; left untouched." -ForegroundColor Yellow
    } else {
        $merged = $existingPatch.TrimEnd() + "`n`n" + ($missing -join "`n`n") + "`n"
        Write-Utf8NoBom $PatchFile $merged
        Write-Host "      Merged $($missing.Count) missing entry/entries" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Registration complete" -ForegroundColor Cyan
Write-Host " Config written to: $PatchFile" -ForegroundColor Cyan
Write-Host " Plugin:  $PluginName (id: $PluginEntryId, in-process routing)" -ForegroundColor Cyan
Write-Host " Local:   lm-studio at http://127.0.0.1:1234/v1 (override with localEndpoint)" -ForegroundColor Cyan
Write-Host " Cloud:   deepseek-official / deepseek-chat (needs `$env:DEEPSEEK_API_KEY)" -ForegroundColor Cyan
Write-Host ""
Write-Host " Restart the profile for the plugin to load." -ForegroundColor Cyan
Write-Host " If you do not run LM Studio, set localEndpoint and localModel." -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan
