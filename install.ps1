<#
.SYNOPSIS
    安装或卸载 bili-lite（DeepSeek Harness skill）。

.DESCRIPTION
    默认把当前目录复制到 %USERPROFILE%\.dsh\skills\bili-lite。
    - 已安装时先把旧目录整体备份为 bili-lite.bak-<yyyyMMdd-HHmmss>；
    - 旧目录中的 state/ 会复制到新安装目录，不覆盖、不丢失；
    - state/、reports/、node_modules/、.git/ 和 *.log 不会被复制；
    - -WhatIf 只打印计划，不修改任何文件。
    -Uninstall 会删除安装目录（包括 state/ 里的登录 cookie），请谨慎使用。

.PARAMETER Uninstall
    卸载已经安装的 skill。会删除安装目录及其 state/（登录凭证）。

.PARAMETER Destination
    安装目标目录。默认 %USERPROFILE%\.dsh\skills\bili-lite；主要供测试使用。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -WhatIf

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall

.NOTES
    兼容 Windows PowerShell 5.1。本文件必须保存为 UTF-8 with BOM，
    否则 5.1 会把中文注释和字符串错误解码，导致语法错误。
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [switch]$Uninstall,
    [string]$Destination = (Join-Path $env:USERPROFILE '.dsh\skills\bili-lite')
)

$ErrorActionPreference = 'Stop'
$SourcePath = [System.IO.Path]::GetFullPath($PSScriptRoot)
$DestPath = [System.IO.Path]::GetFullPath($Destination)
$DestLeaf = Split-Path -Leaf $DestPath
$SkillsRoot = Split-Path -Parent $DestPath

$ExcludeDirs = @('state', 'reports', 'node_modules', '.git')
$ExcludeFiles = @('.DS_Store')

function Copy-SkillTree {
    param(
        [Parameter(Mandatory = $true)][string]$From,
        [Parameter(Mandatory = $true)][string]$To
    )
    if (-not (Test-Path -LiteralPath $To)) {
        New-Item -ItemType Directory -Path $To -Force | Out-Null
    }
    foreach ($item in Get-ChildItem -LiteralPath $From -Force) {
        if ($item.PSIsContainer) {
            if ($script:ExcludeDirs -contains $item.Name) { continue }
            Copy-SkillTree -From $item.FullName -To (Join-Path $To $item.Name)
        }
        else {
            if ($script:ExcludeFiles -contains $item.Name) { continue }
            if ($item.Extension -eq '.log') { continue }
            Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $To $item.Name) -Force
        }
    }
}

function Get-UniqueBackupPath {
    param([string]$BasePath, [string]$Stamp)
    $candidate = Join-Path $BasePath ("$script:DestLeaf.bak-$Stamp")
    $index = 1
    while (Test-Path -LiteralPath $candidate) {
        $candidate = Join-Path $BasePath ("$script:DestLeaf.bak-$Stamp-$index")
        $index++
    }
    return $candidate
}

if ([string]::IsNullOrWhiteSpace($Destination)) {
    throw '目标目录不能为空。'
}
if ([string]::IsNullOrWhiteSpace($DestLeaf) -or [string]::IsNullOrWhiteSpace($SkillsRoot)) {
    throw "无法识别的目标目录：$DestPath"
}
# ── 卸载 ────────────────────────────────────────────────────────────────────
if ($Uninstall) {
    if (-not (Test-Path -LiteralPath $DestPath)) {
        Write-Host "未安装：$DestPath 不存在，无需卸载。"
        return
    }
    if (-not (Test-Path -PathType Container -LiteralPath $DestPath)) {
        throw "目标不是目录，拒绝删除：$DestPath"
    }
    $looksInstalled =
        (Test-Path -LiteralPath (Join-Path $DestPath 'src\cli.mjs')) -or
        (Test-Path -LiteralPath (Join-Path $DestPath 'SKILL.md'))
    if (-not $looksInstalled) {
        throw "目标目录不像 bili-lite（缺少 src\cli.mjs 或 SKILL.md），拒绝删除：$DestPath"
    }

    Write-Host "将卸载：$DestPath"
    Write-Host '注意：state/state.json 中的登录 cookie 会随目录一起删除。'
    if ($PSCmdlet.ShouldProcess($DestPath, '删除 bili-lite skill 目录')) {
        Remove-Item -LiteralPath $DestPath -Recurse -Force
        Write-Host '已卸载。'
    }
    else {
        Write-Host '（-WhatIf）未做任何修改。'
    }
    return
}

# ── 安装 ────────────────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath (Join-Path $SourcePath 'src\cli.mjs'))) {
    throw "源目录缺少 src\cli.mjs，请在 bili-lite 项目根目录运行本脚本：$SourcePath"
}
if ($SourcePath -eq $DestPath) {
    throw '源目录和目标目录相同，请从源码目录运行安装。'
}
if (Test-Path -LiteralPath $DestPath) {
    if (-not (Test-Path -PathType Container -LiteralPath $DestPath)) {
        throw "目标位置已存在同名文件，无法安装：$DestPath"
    }
}

Write-Host 'bili-lite 安装器'
Write-Host "  源目录：$SourcePath"
Write-Host "  目标目录：$DestPath"
if (Test-Path -LiteralPath $DestPath) {
    Write-Host '  已安装：是（将先整体备份，再保留原有 state/）'
}
else {
    Write-Host '  已安装：否（全新安装）'
}

if (-not $PSCmdlet.ShouldProcess($DestPath, '安装 bili-lite skill')) {
    Write-Host '（-WhatIf）未做任何修改。'
    return
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$staging = Join-Path $SkillsRoot ("$DestLeaf.installing-$stamp")
$backup = $null
$backupCreated = $false

try {
    if (-not (Test-Path -LiteralPath $SkillsRoot)) {
        New-Item -ItemType Directory -Path $SkillsRoot -Force | Out-Null
    }

    if (Test-Path -LiteralPath $DestPath) {
        $backup = Get-UniqueBackupPath -BasePath $SkillsRoot -Stamp $stamp
        Move-Item -LiteralPath $DestPath -Destination $backup
        $backupCreated = $true
        Write-Host "已备份旧版本：$backup"
    }

    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    Copy-SkillTree -From $SourcePath -To $staging

    if ($backupCreated) {
        # 运行时数据不是安装产物：state/（登录态/候选/历史）和 reports/（日报）都要保留
        foreach ($runtimeDir in @('state', 'reports')) {
            $oldDir = Join-Path $backup $runtimeDir
            if (Test-Path -LiteralPath $oldDir) {
                Copy-Item -LiteralPath $oldDir -Destination (Join-Path $staging $runtimeDir) -Recurse -Force
            }
        }
        Write-Host '已保留原有 state/ 与 reports/（登录态、候选、历史记录、日报）。'
    }

    Move-Item -LiteralPath $staging -Destination $DestPath
}
catch {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($backupCreated -and -not (Test-Path -LiteralPath $DestPath) -and (Test-Path -LiteralPath $backup)) {
        Move-Item -LiteralPath $backup -Destination $DestPath
        Write-Host "安装失败，已回滚旧版本：$DestPath" -ForegroundColor Yellow
    }
    throw
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
if ($backupCreated) {
    Write-Host "  旧版本备份：$backup"
}
Write-Host '验证命令：'
Write-Host "  node `"$DestPath\src\cli.mjs`" status"
Write-Host '首次使用先登录：'
Write-Host "  node `"$DestPath\src\cli.mjs`" login"
