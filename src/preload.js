const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Tab Management
  tabs: {
    create: (url) => ipcRenderer.invoke('tabs:create', url),
    switch: (tabId) => ipcRenderer.invoke('tabs:switch', tabId),
    close: (tabId) => ipcRenderer.invoke('tabs:close', tabId),
    getAll: () => ipcRenderer.invoke('tabs:getAll'),
    onUpdated: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('tabs:updated', handler);
      return () => ipcRenderer.removeListener('tabs:updated', handler);
    }
  },
  createTab: (url) => ipcRenderer.invoke('tabs:create', url),
  switchTab: (tabId) => ipcRenderer.invoke('tabs:switch', tabId),
  closeTab: (tabId) => ipcRenderer.invoke('tabs:close', tabId),
  onTabsUpdated: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('tabs:updated', handler);
    return () => ipcRenderer.removeListener('tabs:updated', handler);
  },

  // Browser Controls & Layout
  navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
  goBack: () => ipcRenderer.invoke('browser:goBack'),
  goForward: () => ipcRenderer.invoke('browser:goForward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  stopNavigation: () => ipcRenderer.invoke('browser:stop'),
  updateBounds: (bounds) => ipcRenderer.invoke('browser:updateBounds', bounds),
  openDevTools: () => ipcRenderer.invoke('browser:openDevTools'),
  openExternal: (url) => ipcRenderer.invoke('browser:openExternal', url),
  executeScript: (script) => ipcRenderer.invoke('browser:executeScript', script),

  // Recorder Controls
  startRecording: (name) => ipcRenderer.invoke('recorder:start', name),
  pauseRecording: () => ipcRenderer.invoke('recorder:pause'),
  resumeRecording: () => ipcRenderer.invoke('recorder:resume'),
  stopRecording: () => ipcRenderer.invoke('recorder:stop'),
  getStatus: () => ipcRenderer.invoke('recorder:getStatus'),
  getActions: () => ipcRenderer.invoke('recorder:getActions'),
  clearCurrentRecords: () => ipcRenderer.invoke('recorder:clear'),
  listSessions: () => ipcRenderer.invoke('recorder:listSessions'),
  loadSession: (sessionId) => ipcRenderer.invoke('recorder:loadSession', sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke('recorder:deleteSession', sessionId),
  clearAllRecordings: () => ipcRenderer.invoke('recorder:clearAllRecordings'),
  openSessionFolder: (sessionId) => ipcRenderer.invoke('recorder:openSessionFolder', sessionId),
  exportHAR: (sessionId) => ipcRenderer.invoke('recorder:exportHAR', sessionId),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  // Chrome 3-Dots App Menu
  showMenu: (options) => ipcRenderer.invoke('app:showMenu', options),
  onMenuAction: (callback) => {
    const handler = (event, action) => callback(action);
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.removeListener('menu:action', handler);
  },

  // Element Interaction & Button Controls
  interaction: {
    startPicker: () => ipcRenderer.invoke('interaction:startPicker'),
    stopPicker: () => ipcRenderer.invoke('interaction:stopPicker'),
    click: (target) => ipcRenderer.invoke('interaction:click', target),
    dblclick: (target) => ipcRenderer.invoke('interaction:dblclick', target),
    rightclick: (target) => ipcRenderer.invoke('interaction:rightclick', target),
    hover: (target) => ipcRenderer.invoke('interaction:hover', target),
    type: (target) => ipcRenderer.invoke('interaction:type', target),
    pressKey: (key) => ipcRenderer.invoke('interaction:pressKey', key),
    scroll: (target) => ipcRenderer.invoke('interaction:scroll', target),
    getElementInfo: (selector) => ipcRenderer.invoke('interaction:getElementInfo', selector),
    setValue: (selector, value) => ipcRenderer.invoke('interaction:setValue', selector, value),
    selectOption: (selector, value) => ipcRenderer.invoke('interaction:selectOption', selector, value),
    getAttribute: (selector, attribute) => ipcRenderer.invoke('interaction:getAttribute', selector, attribute),
    waitForElement: (selector, timeout) => ipcRenderer.invoke('interaction:waitForElement', selector, timeout),
    uploadFile: (target) => ipcRenderer.invoke('interaction:uploadFile', target),
    evaluate: (expression) => ipcRenderer.invoke('interaction:evaluate', expression),
    onElementSelected: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('interaction:elementSelected', handler);
      return () => ipcRenderer.removeListener('interaction:elementSelected', handler);
    },
    onPickerCancelled: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('interaction:pickerCancelled', handler);
      return () => ipcRenderer.removeListener('interaction:pickerCancelled', handler);
    },
    onPhoneCaptured: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('interaction:phoneCaptured', handler);
      return () => ipcRenderer.removeListener('interaction:phoneCaptured', handler);
    }
  },

  // Event Subscriptions
  onNetworkEvent: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('network:event', handler);
    return () => ipcRenderer.removeListener('network:event', handler);
  },
  onActionRecorded: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('action:recorded', handler);
    return () => ipcRenderer.removeListener('action:recorded', handler);
  },
  onBrowserState: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('browser:state', handler);
    return () => ipcRenderer.removeListener('browser:state', handler);
  }
});
