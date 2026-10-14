# 职责：从实际安装的 WebView2 / Edge 版本获取匹配的官方 Edge Driver，仅用于 Windows CI。
<#
.SYNOPSIS
下载并验证与本机浏览器版本、架构匹配的 Microsoft Edge Driver。
.PARAMETER OutputDirectory
存放独立下载目录、解压目录和版本证据的绝对路径；不会修改浏览器或系统配置。
.OUTPUTS
输出包含 driver_path、browser_path、browser_version、architecture 的 JSON，并写入 GITHUB_OUTPUT（如存在）。
.NOTES
浏览器缺失、架构不支持、下载失败或驱动版本不匹配都会终止，不回退到其他版本。
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw '此脚本只能在 Windows CI 上执行。' }
if (-not [IO.Path]::IsPathFullyQualified($OutputDirectory)) { throw 'OutputDirectory 必须是绝对路径。' }

<#
.SYNOPSIS
从候选安装目录读取真实浏览器可执行文件及版本，不依赖可能过期的注册表版本。
.PARAMETER Pattern
浏览器可执行文件的绝对路径或安装版本目录通配模式。
.OUTPUTS
返回路径与四段版本号记录；不存在时返回空集合，版本无法识别时抛出异常。
#>
function Get-InstalledBrowser {
    param([Parameter(Mandatory = $true)][string]$Pattern)
    foreach ($file in @(Get-ChildItem -Path $Pattern -File -ErrorAction SilentlyContinue)) {
        $productVersion = $file.VersionInfo.ProductVersion
        if ($productVersion -notmatch '^(\d+\.\d+\.\d+\.\d+)(?:\s.*)?$') {
            throw "无法读取浏览器真实版本：$($file.FullName) ($productVersion)"
        }
        [PSCustomObject]@{ Path = $file.FullName; Version = [version]$Matches[1] }
    }
}

$architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "不支持的 Windows 架构：$env:PROCESSOR_ARCHITECTURE" }
}
$archiveName = if ($architecture -eq 'arm64') { 'edgedriver_winarm64.zip' } else { 'edgedriver_win64.zip' }
$roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA) |
    Where-Object { $_ } | Select-Object -Unique
# Tauri 使用 WebView2：优先读取其真实运行时；仅在未安装时检查 Edge，避免拿 Edge 更新版本匹配旧 WebView2。
$webViews = @(
    foreach ($root in $roots) {
        Get-InstalledBrowser -Pattern (Join-Path $root 'Microsoft/EdgeWebView/Application/*/msedgewebview2.exe')
    }
)
$browsers = if ($webViews.Count -gt 0) { $webViews } else {
    @(
        foreach ($root in $roots) {
            Get-InstalledBrowser -Pattern (Join-Path $root 'Microsoft/Edge/Application/msedge.exe')
        }
    )
}
$browser = $browsers | Sort-Object -Property Version -Descending | Select-Object -First 1
if (-not $browser) { throw '没有找到已安装的 Microsoft Edge 或 WebView2 可执行文件；禁止猜测版本。' }
$version = $browser.Version.ToString()
$url = "https://msedgedriver.microsoft.com/$version/$archiveName"

$null = New-Item -ItemType Directory -Path $OutputDirectory -Force
# 下载与解压各用全新目录，脚本始终留在仓库目录，不从不可信压缩包目录运行解释器。
$downloadDirectory = Join-Path $OutputDirectory ("download-" + [guid]::NewGuid().ToString('N'))
$expandedDirectory = Join-Path $OutputDirectory ("expanded-" + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $downloadDirectory
$null = New-Item -ItemType Directory -Path $expandedDirectory
$archivePath = Join-Path $downloadDirectory $archiveName
Invoke-WebRequest -Uri $url -OutFile $archivePath -TimeoutSec 120 -MaximumRedirection 0
Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedDirectory
$driverPath = Join-Path $expandedDirectory 'msedgedriver.exe'
if (-not (Test-Path -LiteralPath $driverPath -PathType Leaf)) { throw '官方压缩包没有 msedgedriver.exe。' }
$driverVersion = (& $driverPath --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $driverVersion -notmatch '^MSEdgeDriver (\d+\.\d+\.\d+\.\d+)(?:\s|$)') {
    throw "无法验证 Edge Driver 版本：$driverVersion"
}
if ($Matches[1] -ne $version) { throw "浏览器版本 $version 与驱动版本 $($Matches[1]) 不匹配。" }

$metadataPath = Join-Path $OutputDirectory 'windows-driver.json'
$metadata = [ordered]@{
    driver_path = [IO.Path]::GetFullPath($driverPath)
    browser_path = $browser.Path
    browser_version = $version
    architecture = $architecture
    download_url = $url
    driver_version_output = $driverVersion
    prepared_at = [DateTime]::UtcNow.ToString('o')
}
$json = $metadata | ConvertTo-Json
[IO.File]::WriteAllText($metadataPath, $json, [Text.UTF8Encoding]::new($false))
if ($env:GITHUB_OUTPUT) {
    foreach ($entry in $metadata.GetEnumerator()) {
        if ($entry.Key -in @('driver_path', 'browser_path', 'browser_version', 'architecture')) {
            [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "$($entry.Key)=$($entry.Value)`n", [Text.UTF8Encoding]::new($false))
        }
    }
    [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "metadata_path=$metadataPath`n", [Text.UTF8Encoding]::new($false))
}
Write-Output $json
