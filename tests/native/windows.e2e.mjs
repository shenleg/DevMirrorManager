/** 职责：通过 tauri-driver 和真实 Windows WebView2 验证官方目录、搜索、单选、失配清除与刷新，保留原生截图及结果。 */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const [application, driverExecutable, nativeDriver, outputDirectory] = process.argv.slice(2);
const endpoint = 'http://127.0.0.1:4444';
// 网络与原生启动耗时不稳定，但必须在固定预算内失败；不得把超时转成不支持平台。
const deadline = Date.now() + 240_000;
const architecture = { AMD64: 'x64', ARM64: 'arm64' }[process.env.PROCESSOR_ARCHITECTURE] ?? process.arch;
const result = { status: 'failed', platform: process.platform, architecture, nodeArchitecture: process.arch, startedAt: new Date().toISOString(), checks: [] };
let driver, sessionId, driverError, driverExit;
let stdout, stderr;

/** 向固定本地 WebDriver 发送 method/route/body；返回协议 value，超时、HTTP 或协议错误均抛出。 */
async function request(method, route, body, timeout = 15_000) {
  requireDriver();
  const remaining = deadline - Date.now();
  assert(remaining > 0, '原生 E2E 已超过总时间预算');
  const response = await fetch(`${endpoint}${route}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(Math.min(timeout, remaining)),
  });
  const payload = await response.json();
  requireDriver();
  if (!response.ok || payload.value?.error) {
    throw new Error(`${method} ${route}: ${JSON.stringify(payload)}`);
  }
  return payload.value;
}

/** 验证固定 port 空闲，避免连接到别的测试会话；返回完成承诺，端口占用或监听失败抛出。 */
async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

/** 确认启动的驱动仍存活；无返回值，启动失败或提前退出时抛出，不进行平台回退。 */
function requireDriver() {
  if (driverError) throw driverError;
  assert.equal(driverExit, undefined, `tauri-driver 提前退出：${JSON.stringify(driverExit)}`);
}

/** 按 label 对 probe 的实际响应做有界轮询；返回首个满足 predicate 的值，驱动退出或到期抛出。 */
async function poll(label, probe, predicate, timeout = 90_000) {
  const expires = Math.min(deadline, Date.now() + timeout);
  let observed;
  while (Date.now() < expires) {
    requireDriver();
    observed = await probe();
    if (predicate(observed)) return observed;
    await delay(250);
  }
  throw new Error(`${label} 超时，最后状态：${JSON.stringify(observed)}`);
}

/** 在真实 WebView 同步执行固定 script，args 为业务输入；返回脚本结果，WebDriver 错误抛出。 */
async function execute(script, args = []) {
  return request('POST', `/session/${sessionId}/execute/sync`, { script, args });
}

/** 读取页面真实 DOM 状态；返回目录与单选证据，页面或驱动执行失败时抛出。 */
async function snapshot() {
  return execute(`return {
    query: document.querySelector('#release-query')?.value,
    source: document.querySelector('.source')?.textContent?.trim(),
    status: document.querySelector('[role="status"]')?.textContent?.trim(),
    alerts: Array.from(document.querySelectorAll('[role="alert"], .warning'), e => e.textContent),
    versions: Array.from(document.querySelectorAll('input[name="release"]'), e => e.value),
    disabled: Array.from(document.querySelectorAll('input[name="release"]'), e => e.matches(':disabled')),
    checked: Array.from(document.querySelectorAll('input[name="release"]:checked'), e => e.value),
    summary: document.querySelector('.selection-summary')?.textContent?.trim(),
    feedback: document.querySelector('.feedback')?.textContent?.trim(),
    checkedAt: document.querySelector('.metadata dd')?.textContent?.trim(),
    refreshDisabled: Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim() === '刷新目录')?.disabled
  };`);
}

/** 判断 state 是否为可操作的真实官方目录；返回条件值，不抛出异常。 */
function ready(state) {
  return state.source === 'https://nodejs.org/dist/index.json'
    && state.status === `目录就绪，${state.versions.length} 个发行版本。`
    && state.alerts.length === 0 && state.versions.length > 0
    && state.versions.every(version => /^v\d+\.\d+\.\d+$/.test(version))
    && state.disabled.every(disabled => !disabled) && state.refreshDisabled === false
    && !!state.checkedAt && state.checkedAt !== '尚未成功校验';
}

/** 查找可操作元素；selector 为固定CSS或已校验发行标识，返回WebDriver元素编号，查找失败抛出。 */
async function element(selector) {
  const reference = await request('POST', `/session/${sessionId}/element`, { using: 'css selector', value: selector });
  return reference['element-6066-11e4-a52e-4f735466cecf'];
}

/** 使用WebDriver真实输入填写query；返回完成承诺，不可见、禁用或驱动失败抛出。 */
async function search(query) {
  const identifier = await element('#release-query');
  await request('POST', `/session/${sessionId}/element/${identifier}/clear`, {});
  await request('POST', `/session/${sessionId}/element/${identifier}/value`, { text: query, value: Array.from(query) });
}

/** 使用WebDriver点击version对应radio；返回权威展示结果，候选缺失、不可交互或驱动失败抛出。 */
async function select(version) {
  assert(/^v\d+\.\d+\.\d+$/.test(version), '无效发行标识不能用于元素查询');
  const identifier = await element(`input[name="release"][value="${version}"]`);
  await request('POST', `/session/${sessionId}/element/${identifier}/click`, {});
  return poll(`选择 ${version}`, snapshot, state => ready(state)
    && state.checked.length === 1 && state.checked[0] === version && state.summary === '当前选择：' + version);
}

/** 保存 name 对应的真实 WebView 截图；返回写入承诺，截图缺失或文件失败时抛出。 */
async function screenshot(name) {
  const encoded = await request('GET', `/session/${sessionId}/screenshot`);
  assert.equal(typeof encoded, 'string', 'WebDriver 没有返回截图');
  const image = Buffer.from(encoded, 'base64');
  assert(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), '截图不是 PNG');
  await writeFile(path.join(outputDirectory, `${name}.png`), image);
}

/** 清理本次 session 和驱动进程树；无参数，返回完成承诺，清理异常向调用方传递。 */
async function cleanup() {
  let failure;
  if (sessionId && driverExit === undefined && !driverError) {
    try {
      const response = await fetch(`${endpoint}/session/${sessionId}`, { method: 'DELETE', signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`删除 WebDriver session 失败：${response.status}`);
    } catch (error) { failure = error; }
  }
  if (driver?.pid && driverExit === undefined) {
    try {
      // 失败启动也可能留下 msedgedriver / 应用子进程，必须清理本次 PID 的树，不能全局杀浏览器。
      await new Promise((resolve, reject) => execFile(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(driver.pid), '/T', '/F'], { timeout: 10_000 }, error => error ? reject(error) : resolve()));
    } catch (error) { if (driverExit === undefined) failure ??= error; }
  }
  for (const stream of [stdout, stderr]) {
    if (stream && !stream.destroyed && !stream.writableFinished) await new Promise(resolve => stream.end(resolve));
  }
  if (failure) throw failure;
}

try {
  assert.equal(process.argv.length, 6, '用法：node tests/native/windows.e2e.mjs <app-absolute> <tauri-driver-absolute> <msedgedriver-absolute> <output-absolute>');
  for (const value of [application, driverExecutable, nativeDriver, outputDirectory]) assert(path.isAbsolute(value), '所有路径必须为绝对路径');
  await mkdir(outputDirectory, { recursive: true });
  assert.equal(process.platform, 'win32', '本测试只能在 Windows 执行');
  for (const executable of [application, driverExecutable, nativeDriver]) await access(executable);
  await requireFreePort(4444);
  await requireFreePort(4445);
  stdout = createWriteStream(path.join(outputDirectory, 'tauri-driver.stdout.log'));
  stderr = createWriteStream(path.join(outputDirectory, 'tauri-driver.stderr.log'));
  stdout.on('error', error => { driverError = error; });
  stderr.on('error', error => { driverError = error; });
  driver = spawn(driverExecutable, ['--native-driver', nativeDriver, '--port', '4444', '--native-port', '4445'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  driver.on('error', error => { driverError = error; });
  driver.on('exit', (code, signal) => { driverExit = { code, signal }; });
  driver.stdout.pipe(stdout);
  driver.stderr.pipe(stderr);
  await poll('WebDriver 启动', async () => {
    try { return await request('GET', '/status', undefined, 2_000); }
    catch (error) {
      // 只允许启动期间尚未监听的连接错误重试；协议错误和驱动退出必须立即失败。
      requireDriver();
      if (error.cause?.code === 'ECONNREFUSED') return null;
      throw error;
    }
  }, status => status?.ready === true, 30_000);
  const session = await request('POST', '/session', { capabilities: { alwaysMatch: {
    browserName: 'wry', 'tauri:options': { application },
  } } }, 60_000);
  sessionId = session.sessionId;
  assert(sessionId, 'WebDriver 没有创建 session');
  const initial = await poll('真实官方目录加载', snapshot, ready);
  assert.equal(initial.checked.length, 0, '初始目录不应自动选择');
  assert.equal(initial.summary, '尚未选择发行版本');
  result.checks.push({ name: 'official-catalog-ready', count: initial.versions.length, checkedAt: initial.checkedAt });
  await screenshot('01-ready');

  await search('  V22.1  ');
  const filtered = await poll('V22.1 原始查询', snapshot, state => ready(state) && state.query === '  V22.1  '
    && state.versions.every(version => version.startsWith('v22.1')));
  assert(filtered.versions.some(version => version.startsWith('v22.10.')), '22.1 前缀必须保留真实目录中的 22.10');
  assert(filtered.versions.length >= 2, '真实目录应提供至少两个有效候选，不能用假目录补齐');
  const [first, second] = filtered.versions;
  assert.notEqual(first, second, '候选版本必须不同');
  await select(first);
  await select(second);
  result.checks.push({ name: 'raw-prefix-and-single-selection', query: filtered.query, count: filtered.versions.length, selected: [first, second] });
  await screenshot('02-search-selection');

  await search('24.10');
  const cleared = await poll('失配清除且不自动改选', snapshot, state => ready(state) && state.query === '24.10'
    && state.versions.every(version => version.startsWith('v24.10.')) && state.checked.length === 0
    && state.summary === '尚未选择发行版本' && state.feedback.includes('已清除单选'));
  result.checks.push({ name: 'mismatch-clears-no-auto-select', count: cleared.versions.length });
  await screenshot('03-cleared');

  // checkedAt 以秒显示：跨过显示精度后刷新，不能把同秒文本不变误判为未刷新。
  await delay(1_100);
  const refreshElement = await element('.panel-heading button');
  await request('POST', `/session/${sessionId}/element/${refreshElement}/click`, {});
  const refreshed = await poll('成功刷新更新校验时间', snapshot, state => ready(state) && state.query === '24.10'
    && state.checkedAt !== cleared.checkedAt && state.checked.length === 0 && state.summary === '尚未选择发行版本');
  result.checks.push({ name: 'refresh-success', before: cleared.checkedAt, after: refreshed.checkedAt });
  await screenshot('04-refreshed');
  result.status = 'passed';
} catch (error) {
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch (error) { result.status = 'failed'; result.cleanupError = error.stack ?? String(error); process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  if (outputDirectory && path.isAbsolute(outputDirectory)) {
    try {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(path.join(outputDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    } catch (error) { result.status = 'failed'; result.artifactError = String(error); process.exitCode = 1; }
  }
  console.log(JSON.stringify(result, null, 2));
}
