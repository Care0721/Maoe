// preload.js - 渲染进程与主进程桥接
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mengmoe', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  // 小说模式（多源数据源）接口：所有调用首参为 source id（'wenku8' | 'linovelib' | 'zssq' | 'smcn'）
  novel: {
    // 源列表与元数据
    sources: () => ipcRenderer.invoke('novel:sources'),
    meta: (src) => ipcRenderer.invoke('novel:meta', src),

    // 登录/登出/状态（wenku8 / linovelib 等）
    login: (src, u, p) => ipcRenderer.invoke('novel:login', src, u, p),
    status: (src) => ipcRenderer.invoke('novel:status', src),
    logout: (src) => ipcRenderer.invoke('novel:logout', src),
    openExternal: (url) => ipcRenderer.invoke('novel:openExternal', url),

    // 浏览
    home: (src) => ipcRenderer.invoke('novel:home', src),
    rank: (src, key, page) => ipcRenderer.invoke('novel:rank', src, key, page),
    full: (src, key, page) => ipcRenderer.invoke('novel:full', src, key, page),
    search: (src, kw) => ipcRenderer.invoke('novel:search', src, kw),
    tag: (src, t) => ipcRenderer.invoke('novel:tag', src, t),
    cat: (src, cls, page, fullflag) => ipcRenderer.invoke('novel:cat', src, cls, page, fullflag),
    categories: (src) => ipcRenderer.invoke('novel:categories', src),

    // 详情/目录/正文
    detail: (src, id) => ipcRenderer.invoke('novel:detail', src, id),
    catalog: (src, read) => ipcRenderer.invoke('novel:catalog', src, read),
    chapter: (src, read, cid) => ipcRenderer.invoke('novel:chapter', src, read, cid)
  }
});
