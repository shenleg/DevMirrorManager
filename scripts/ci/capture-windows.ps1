# 捕获指定应用主窗口；不截取整个桌面或读取其他进程的窗口内容。
<#
.SYNOPSIS
仅捕获目标应用的可见主窗口。
.PARAMETER ProcessId
本次启动的应用进程编号，不扫描其他应用内容。
.PARAMETER OutputPath
新的PNG输出文件路径，拒绝覆盖已有文件。
.OUTPUTS
成功保存PNG并输出窗口尺寸；无窗口、尺寸异常、截图或文件保存失败时终止。
#>
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $OutputPath) { throw '拒绝覆盖已有截图' }
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr device, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
$process = Get-Process -Id $ProcessId
$process.Refresh()
$window = $process.MainWindowHandle
if ($window -eq [IntPtr]::Zero -or -not [WindowCapture]::IsWindowVisible($window)) { throw '目标应用没有可见主窗口' }
$rect = New-Object WindowCapture+Rect
if (-not [WindowCapture]::GetWindowRect($window, [ref]$rect)) { throw '无法读取目标窗口位置' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 100 -or $height -lt 100) { throw '目标窗口尺寸无效' }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$context = $graphics.GetHdc()
try {
    # PW_RENDERFULLCONTENT：让WebView窗口提供自身像素，避免读取被覆盖的个人桌面区域。
    if (-not [WindowCapture]::PrintWindow($window, $context, 2)) { throw '目标窗口拒绝截图' }
} finally { $graphics.ReleaseHdc($context) }
try { $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png) }
finally { $graphics.Dispose(); $bitmap.Dispose() }
Write-Output "Captured $width x $height target window"
