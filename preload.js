const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('steamAPI', {
  fetchAllDeals: () => ipcRenderer.invoke('fetch-deals'),
  fetchAllNewReleases: () => ipcRenderer.invoke('fetch-new-releases'),
  fetchPriceInfo: (appids) => ipcRenderer.invoke('fetch-price-info', appids),
  openStore: (appid) => ipcRenderer.invoke('open-store', appid),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  getCurrentVersion: () => ipcRenderer.invoke('get-current-version'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
});
