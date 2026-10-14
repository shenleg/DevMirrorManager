// 用 ScreenCaptureKit 捕获指定进程唯一可见主窗口，不读取完整桌面或其他应用。
import Foundation
import AppKit
import ScreenCaptureKit
import ImageIO

/// 写入阶段诊断；message为当前捕获步骤，无返回值；stderr不可写时由系统报告输出失败。
// 每个阶段直接写stderr，权限等待与API捕获挂起不能表现成无日志的同一超时。
func reportStage(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}
reportStage("capture helper entered")
let args = CommandLine.arguments
guard args.count == 3, let pid = Int32(args[1]) else { fatalError("用法：capture-macos.swift <pid> <new-output.png>") }
let destination = URL(fileURLWithPath: args[2])
guard !FileManager.default.fileExists(atPath: destination.path) else { fatalError("拒绝覆盖截图") }

// 新 SDK 已移除旧 CGWindowListCreateImage；runner 为 macOS 15+，使用受支持的目标窗口捕获。
// 命令行解释器也需初始化 WindowServer 连接，再在主执行器创建窗口过滤器。
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
Task { @MainActor in
    do {
        reportStage("listing shareable target windows")
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        reportStage("shareable windows received")
        guard let window = content.windows.first(where: { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width >= 100 }) else {
            throw NSError(domain: "Capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "没有目标应用的可见窗口"])
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        // 使用窗口实际尺寸，避免runner的不同缩放比例产生多余黑边。
        configuration.width = Int(window.frame.width)
        configuration.height = Int(window.frame.height)
        configuration.showsCursor = false
        reportStage("capturing target window \(window.windowID)")
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        reportStage("target window captured")
        guard image.width >= 100, image.height >= 100,
              let output = CGImageDestinationCreateWithURL(destination as CFURL, "public.png" as CFString, 1, nil) else {
            throw NSError(domain: "Capture", code: 2, userInfo: [NSLocalizedDescriptionKey: "目标窗口PNG输出不可用"])
        }
        CGImageDestinationAddImage(output, image, nil)
        guard CGImageDestinationFinalize(output) else { throw NSError(domain: "Capture", code: 3) }
        print("Captured window \(window.windowID), \(image.width)x\(image.height)")
        exit(0)
    } catch {
        fputs("目标窗口截图失败（检查屏幕权限或runner桌面）：\(error)\n", stderr)
        exit(1)
    }
}
dispatchMain()
