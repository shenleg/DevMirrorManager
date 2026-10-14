# 仅临时Windows CI：核对权限等级，以普通用户权限运行完整WebDriver链，不修改正式应用或系统保护。
<#
.SYNOPSIS
核对并降低E2E进程链权限，避免WebView2高完整性进程忽略驱动环境配置。
.PARAMETER Application
正式release可执行文件绝对路径。
.PARAMETER TauriDriver
固定tauri-driver可执行文件绝对路径。
.PARAMETER EdgeDriver
匹配当前运行时的微软驱动绝对路径。
.PARAMETER OutputDirectory
本轮新建证据目录；内层写入测试结果，拒绝复用旧结果。
.PARAMETER Medium
仅供本脚本降权后调用；此时必须验证实际普通权限再执行测试。
.OUTPUTS
传递E2E退出码，保存权限级别和版本证据；下载校验、权限级别或测试失败均明确失败。
#>
param(
    [Parameter(Mandatory)][string]$Application,
    [Parameter(Mandatory)][string]$TauriDriver,
    [Parameter(Mandatory)][string]$EdgeDriver,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [switch]$Medium
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot/../..").Path
$whoami = Join-Path $env:SystemRoot 'System32/whoami.exe'
$groups = (& $whoami /groups | Out-String)
$level = if ($groups.Contains('S-1-16-12288')) { 'High' } elseif ($groups.Contains('S-1-16-8192')) { 'Medium' } else { 'Other' }

if ($Medium) {
    if ($level -ne 'Medium') { throw "降权未生效，实际完整性级别：$level" }
    $null = New-Item -ItemType Directory -Path $OutputDirectory -Force
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'integrity-medium.txt'), $groups)
    Set-Location $root
    node tests/native/windows.e2e.mjs $Application $TauriDriver $EdgeDriver $OutputDirectory
    exit $LASTEXITCODE
}

if (Test-Path -LiteralPath $OutputDirectory) { throw '拒绝复用旧E2E证据目录' }
$null = New-Item -ItemType Directory -Path $OutputDirectory
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'integrity-before.txt'), $groups)
Write-Output "Windows E2E launcher integrity: $level"
if ($level -eq 'Medium') {
    & $PSCommandPath -Application $Application -TauriDriver $TauriDriver -EdgeDriver $EdgeDriver -OutputDirectory $OutputDirectory -Medium
    exit $LASTEXITCODE
}
if ($level -ne 'High') { throw "不能确认可降权的完整性级别：$level" }

# 仅使用runner既有文件权限；不扩展ACL。普通账户不可写时按实际错误失败，另行确认最小权限。
# 用户已明确授权此官方工具；固定版本与GitHub官方摘要，下载/解压各在新空目录。
$tools = Join-Path $root ("artifacts/gsudo-" + [guid]::NewGuid().ToString('N'))
$download = Join-Path $tools 'download'
$expanded = Join-Path $tools 'expanded'
$null = New-Item -ItemType Directory -Path $download
$null = New-Item -ItemType Directory -Path $expanded
$archive = Join-Path $download 'gsudo.portable.zip'
Invoke-WebRequest -Uri 'https://github.com/gerardog/gsudo/releases/download/v2.6.1/gsudo.portable.zip' -OutFile $archive -TimeoutSec 120
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '21130bf178d7b9891207f00bff56f05b6b363ce9cec7b2d084e45fb12ee51f44') { throw 'gsudo官方归档摘要不匹配' }
Expand-Archive -LiteralPath $archive -DestinationPath $expanded
$architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } elseif ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') { 'x64' } else { throw '不支持的runner架构' }
$gsudo = Join-Path $expanded "$architecture/gsudo.exe"
if (-not (Test-Path -LiteralPath $gsudo)) { throw '官方归档缺少对应原生架构gsudo' }
# 只降权，不调用默认High模式，不启用提权缓存或修改注册表策略。
& $gsudo --integrity Medium --wait pwsh -NoProfile -File $PSCommandPath -Application $Application -TauriDriver $TauriDriver -EdgeDriver $EdgeDriver -OutputDirectory $OutputDirectory -Medium
exit $LASTEXITCODE
