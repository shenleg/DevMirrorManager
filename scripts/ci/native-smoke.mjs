/** 原生冒烟入口：等待真实 WebView 的权威就绪报告，再截图目标窗口；进程存活不等于通过。 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [applicationArgument, outputArgument, timeoutArgument = '120000'] = process.argv.slice(2);
if (!applicationArgument || !outputArgument) throw new Error('用法：native-smoke.mjs <application> <new-output-directory> [timeout-ms]');
const application = resolve(applicationArgument);
const output = resolve(outputArgument);
const timeout = Number(timeoutArgument);
if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 180000) throw new Error('就绪期限须为 1–180 秒');
const scripts = dirname(fileURLToPath(import.meta.url));
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const stdout = createWriteStream(resolve(output, 'application.stdout.log'));
const stderr = createWriteStream(resolve(output, 'application.stderr.log'));
const child = spawn(application, [], { env: { ...process.env, CI_SMOKE_DIR: output }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);
let processError;
child.once('error', (error) => { processError = error; });
let exited = false;
child.once('exit', () => { exited = true; });

/** 编译或运行截图辅助；command/args指定已审查的平台代码，budget限定耗时，stage用于诊断；成功无数据返回，失败拒绝。 */
async function capture(command, args, budget = 30000, stage = '目标窗口截图') {
  await new Promise((accept, reject) => {
    const helper = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(resolve(output, command === 'swiftc' ? 'capture-compile.log' : 'capture.log'));
    log.write(`[${stage}] started ${new Date().toISOString()}\n`);
    helper.stdout.pipe(log, { end: false });
    helper.stderr.pipe(log, { end: false });
    // 截图辅助也必须有界，不能让权限弹窗把 runner 永久挂住。
    const timer = setTimeout(() => { log.end(`[${stage}] timeout after ${budget}ms\n`); helper.kill(); reject(new Error(`${stage}超时`)); }, budget);
    helper.once('error', (error) => { clearTimeout(timer); log.end(); reject(error); });
    helper.once('exit', (code) => { clearTimeout(timer); if (!log.writableEnded) log.end(`[${stage}] exited ${code}\n`); code === 0 ? accept() : reject(new Error(`${stage}失败：退出码 ${code}`)); });
  });
}

let result;
try {
  const macCapture = resolve(output, 'capture-macos');
  if (process.platform === 'darwin') {
    // Swift解释器的冷编译不属于截图耗时；单独编译并记录，截图仍保留30秒硬门槛。
    await capture('swiftc', [resolve(scripts, 'capture-macos.swift'), '-o', macCapture], 120000, '截图辅助编译');
  }
  const deadline = Date.now() + timeout;
  let readiness;
  while (Date.now() < deadline) {
    if (processError) throw processError;
    if (exited) throw new Error(`原生应用在就绪前退出：${child.exitCode}`);
    try { readiness = JSON.parse(await readFile(resolve(output, 'ready.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(200);
  }
  if (!readiness) throw new Error('未收到真实 WebView 就绪报告；进程存活不能证明桌面可用');
  if (readiness.status !== 'passed') throw new Error(`WebView 冒烟失败：${readiness.reason ?? '无说明'}`);
  if (readiness.arch !== process.arch.replace('x64', 'x86_64').replace('arm64', 'aarch64')) throw new Error('就绪报告架构与宿主不匹配');
  // 票15要求真实 IPC 清单预览；旧目录冒烟的 passed 不能冒充目标验证完成。
  const expectedTargets = ['macos/x64', 'macos/arm64', 'windows/x64', 'windows/arm64', 'linux/x64', 'linux/arm64'];
  const observedTargets = readiness.previews?.map(preview => `${preview.selection.target.os}/${preview.selection.target.arch}`);
  if (JSON.stringify(observedTargets) !== JSON.stringify(expectedTargets)
      || !readiness.targetPreserved || !readiness.versionPreserved) throw new Error('原生报告未验证六目标、目标保留与发行版本保留');
  const screenshot = resolve(output, 'native-window.png');
  if (process.platform === 'darwin') {
    await capture(macCapture, [String(child.pid), screenshot]);
  } else if (process.platform === 'win32') {
    await capture('pwsh', ['-NoProfile', '-File', resolve(scripts, 'capture-windows.ps1'), '-ProcessId', String(child.pid), '-OutputPath', screenshot]);
  } else throw new Error(`未支持的原生截图平台：${process.platform}`);
  // 就绪后或截图期间意外退出仍为失败，不能拿残留PNG冒充存活的原生界面。
  if (processError || exited) throw processError ?? new Error(`原生应用在验证期间意外退出：${child.exitCode}`);
  const png = await readFile(screenshot);
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.readUInt32BE(16) < 100 || png.readUInt32BE(20) < 100) throw new Error('目标窗口截图不是有效的可见尺寸 PNG');
  result = { status: 'passed', platform: process.platform, arch: process.arch, readiness, screenshot: 'native-window.png' };
  console.log(JSON.stringify(result));
} catch (error) {
  result = { status: 'failed', platform: process.platform, arch: process.arch, reason: String(error), exitCode: child.exitCode };
  console.error(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  try { await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2)); }
  catch (error) { console.error(`证据保存失败：${error}`); process.exitCode = 1; }
  // 保存证据失败也不能跳过进程清理。
  if (!exited) child.kill();
  await Promise.race([new Promise((accept) => { if (exited) accept(); else child.once('exit', accept); }), delay(5000)]);
  if (!exited) child.kill('SIGKILL');
  stdout.end(); stderr.end();
}
