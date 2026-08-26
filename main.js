const { app, BrowserWindow, shell, Menu, session } = require('electron');
const path = require('path');
// 小说模式数据源（wenku8）- 主进程抓取/解析并通过 IPC 暴露
const { registerNovelIpc } = require('./src/js/novel_api');

// 安全增强：打包后的生产环境禁止通过命令行注入远程调试端口（防止 CDP 附加窃取/篡改）
// 仅开发运行（electron .）时放行，便于本地调试
if (app.isPackaged && process.argv.some((a) => /--(remote-debugging-port|inspect|inspect-brk)/i.test(a))) {
  try { app.quit(); } catch (e) { /* ignore */ }
  process.exit(0);
}

// 萌道 API 服务器 SSL 证书已过期，客户端仅读取公开数据，忽略证书校验
app.commandLine.appendSwitch('ignore-certificate-errors');

// 服务器按 UA 过滤请求：桌面 UA 返回 503，需伪装为移动端 UA
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 680,
    title: 'Maoe',
    icon: path.join(__dirname, 'src', 'icon.png'),
    backgroundColor: '#101010',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // 安全增强：关闭渲染器调试能力，防止通过 DevTools 注入/窃取数据
      devTools: false,
      // 关闭多余的 Node 能力暴露面
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      experimentalFeatures: false
    }
  });

  // 禁用原生右键菜单（防止用「检查元素」打开 DevTools）
  mainWindow.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });

  // 拦截调试快捷键（F12 / Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C / Ctrl+U）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase();
    const isF12 = input.type === 'keyDown' && key === 'f12';
    const isDevShortcut = input.control && input.shift &&
      ['i', 'j', 'c'].includes(key);
    const isViewSource = input.control && key === 'u';
    if (isF12 || isDevShortcut || isViewSource) event.preventDefault();
  });

  // 阻止页面导航到外部协议，仅允许本地 file/about
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!/^(file|about):/i.test(url)) event.preventDefault();
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 允许跨域访问 API（图片 CDN 等）
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Access-Control-Allow-Origin': ['*']
      }
    });
  });

  // 渲染进程 console 转发到终端（便于调试）——生产环境仅输出错误告警，避免泄露内部信息
  mainWindow.webContents.on('console-message', (event, data) => {
    const msg = typeof data === 'string' ? { level: event.level, message: data } : data;
    if (msg.level >= 3) console.log(`[renderer:${msg.level}] ${msg.message}`);
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // 注册小说模式 wenku8 数据源 IPC
  registerNovelIpc();

  // 全局注入移动端 UA，绕过服务器 UA 过滤
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = MOBILE_UA;
    callback({ requestHeaders: details.requestHeaders });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
