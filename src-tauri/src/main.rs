// 桌面进程入口；隐藏 Windows 正式构建的额外控制台窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nodejs_downloader::run();
}
