# BOM-less UTF-8 writer. PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM,
# and JSON.parse rejects a BOM outright (it broke `dsh web` profile loading).
function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

# Registration script for the DeepSeek Harness (DSH) Local Router plugin & provider config.
#
# Renamed from the Laya era: the plugin is `dsh-plugin-local-router` and decides routing
# in-process, so no `layaEndpoint` is written anywhere.
#
# This script MERGES. It never overwrites settings.yaml or cordis.patch.yml wholesale --
# an earlier version did, which would silently discard the plugin's dlpAction setting and
# any other block the operator had added.
$ErrorActionPreference = "Stop"

$PluginName = "dsh-plugin-local-router"

$RootDir = Resolve-Path "$PSScriptRoot\.."
$PluginDir = Join-Path $RootDir "plugin"
$PluginDist = Join-Path $PluginDir "dist\index.js"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Registering DSH Local Router Plugin & Provider Config" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

if (-not (Test-Path $PluginDist)) {
    Write-Host "Building plugin first..." -ForegroundColor Yellow
    Set-Location $PluginDir
    npm run build
    Set-Location $RootDir
}

$UserDshDir = Join-Path $env:USERPROFILE ".dsh"
if (-not (Test-Path $UserDshDir)) {
    New-Item -ItemType Directory -Path $UserDshDir -Force | Out-Null
}

# 1. Register via the DSH CLI (best effort; the file steps below are authoritative)
$dshCli = Get-Command "dsh" -ErrorAction SilentlyContinue
if ($dshCli) {
    Write-Host "[1/3] Registering plugin via DSH CLI..." -ForegroundColor Yellow
    try {
        & dsh plugin --profile web add $PluginDir
    } catch {
        Write-Host "CLI plugin registration step completed." -ForegroundColor Yellow
    }
}

# Ensure the web profile package.json lists the plugin in dsh.profile.bundles
$WebProfileDir = Join-Path $UserDshDir "profiles\web"
if (Test-Path $WebProfileDir) {
    $WebPkgFile = Join-Path $WebProfileDir "package.json"
    if (Test-Path $WebPkgFile) {
        try {
            $webPkg = Get-Content $WebPkgFile -Raw | ConvertFrom-Json
            if ($webPkg.dsh -and $webPkg.dsh.profile -and $webPkg.dsh.profile.bundles) {
                $bundles = @($webPkg.dsh.profile.bundles)
                if ($bundles -notcontains $PluginName) {
                    $bundles += $PluginName
                    $webPkg.dsh.profile.bundles = $bundles
                    Write-Utf8NoBom $WebPkgFile ($webPkg | ConvertTo-Json -Depth 5)
                    Write-Host "Added $PluginName to dsh.profile.bundles" -ForegroundColor Green
                }
            }
        } catch {}
    }
}

# 2. Update ~/.dsh/config.json plugin registry
$ConfigFile = Join-Path $UserDshDir "config.json"
$ConfigObj = @{ plugins = @() }

if (Test-Path $ConfigFile) {
    try {
        $rawConfig = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        if ($rawConfig.plugins) { $ConfigObj = $rawConfig }
    } catch {}
}

$pluginEntry = @{
    name = $PluginName
    path = $PluginDir
    main = $PluginDist
    enabled = $true
}

$alreadyRegistered = $false
$newPlugins = @()
foreach ($p in $ConfigObj.plugins) {
    $isLegacy = ($p.name -eq "dsh-plugin-laya-router")
    if ($p.name -eq $PluginName -or $isLegacy) {
        $newPlugins += $pluginEntry
        $alreadyRegistered = $true
    } else {
        $newPlugins += $p
    }
}
if (-not $alreadyRegistered) { $newPlugins += $pluginEntry }

$ConfigObj.plugins = $newPlugins
Write-Utf8NoBom $ConfigFile ($ConfigObj | ConvertTo-Json -Depth 5)
Write-Host "[2/3] DSH Plugin registered in $ConfigFile" -ForegroundColor Green

# 3. Provider configuration -- MERGE ONLY, never overwrite
Write-Host "[3/3] Merging provider configuration..." -ForegroundColor Yellow

$SettingsFile = Join-Path $UserDshDir "settings.yaml"
$pluginBlock = @"
${PluginName}:
  localProvider: 'lm-studio'
  cloudProvider: 'deepseek-official'
  localModel: 'qwen/qwen3.8-27b'
  cloudModel: 'deepseek-chat'
  contextThreshold: 30000
  # 'local' pins a credential-bearing request to the local worker; 'block' refuses it.
  # Neither ever transmits the credential.
  dlpAction: 'local'
"@

if (Test-Path $SettingsFile) {
    $existing = [System.IO.File]::ReadAllText($SettingsFile)
    if ($existing -match ("(?m)^" + [regex]::Escape($PluginName) + ":")) {
        Write-Host "settings.yaml already has a $PluginName block - left untouched." -ForegroundColor Yellow
    } else {
        $merged = $existing.TrimEnd() + "`r`n`r`n" + $pluginBlock + "`r`n"
        Write-Utf8NoBom $SettingsFile $merged
        Write-Host "Added the $PluginName block to settings.yaml" -ForegroundColor Green
    }
} else {
    $full = @"
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1

$pluginBlock

llm-deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY

llm-pi-ai:
  providers:
    lm-studio:
      api: openai-completions
      baseURL: http://127.0.0.1:1234/v1
      apiKeyEnv: LM_STUDIO_API_KEY
      models:
        - id: qwen/qwen3.8-27b
          name: 'Qwen 3.8 27B Local'
          maxTokens: 16384
"@
    Write-Utf8NoBom $SettingsFile $full
    Write-Host "Created $SettingsFile" -ForegroundColor Green
}

# Profile cordis.patch.yml -- migrate a legacy entry, otherwise append, never clobber
if (Test-Path $WebProfileDir) {
    $PatchFile = Join-Path $WebProfileDir "cordis.patch.yml"
    $patchEntry = @"
- id: $PluginName
  config:
    localProvider: 'lm-studio'
    localModel: 'qwen/qwen3.8-27b'
    cloudProvider: 'deepseek-official'
    cloudModel: 'deepseek-chat'
"@

    if (Test-Path $PatchFile) {
        $existingPatch = [System.IO.File]::ReadAllText($PatchFile)
        if ($existingPatch -match ("(?m)^- id: " + [regex]::Escape($PluginName) + "\s*$")) {
            Write-Host "cordis.patch.yml already lists $PluginName - left untouched." -ForegroundColor Yellow
        } elseif ($existingPatch -match '(?m)^- id: laya-router\s*$') {
            $existingPatch = [regex]::Replace($existingPatch, '(?m)^- id: laya-router\s*$', "- id: $PluginName")
            $existingPatch = [regex]::Replace($existingPatch, '(?m)^\s*layaEndpoint:.*\r?\n', '')
            Write-Utf8NoBom $PatchFile $existingPatch
            Write-Host "Migrated the legacy laya-router entry in cordis.patch.yml" -ForegroundColor Green
        } else {
            $mergedPatch = $existingPatch.TrimEnd() + "`r`n`r`n" + $patchEntry + "`r`n"
            Write-Utf8NoBom $PatchFile $mergedPatch
            Write-Host "Appended the $PluginName entry to cordis.patch.yml" -ForegroundColor Green
        }
    } else {
        Write-Utf8NoBom $PatchFile ($patchEntry + "`r`n")
        Write-Host "Created $PatchFile" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Router & Provider Registration Complete!" -ForegroundColor Cyan
Write-Host " Router Plugin:      $PluginName (in-process routing, no daemon)" -ForegroundColor Cyan
Write-Host " LM Studio Provider: lm-studio (http://127.0.0.1:1234/v1)" -ForegroundColor Cyan
Write-Host " LM Studio Model:    qwen/qwen3.8-27b (maxTokens: 16384)" -ForegroundColor Cyan
Write-Host " DeepSeek Provider:  deepseek-official / deepseek-chat (API key: `$env:DEEPSEEK_API_KEY)" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan