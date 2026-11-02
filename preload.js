const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Browser Controls & Layout
  navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
  goBack: () => ipcRenderer.invoke('browser:goBack'),
  goForward: () => ipcRenderer.invoke('browser:goForward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  stopNavigation: () => ipcRenderer.invoke('browser:stop'),
  updateBounds: (bounds) => ipcRenderer.invoke('browser:updateBounds', bounds),
  openDevTools: () => ipcRenderer.invoke('browser:openDevTools'),
  executeScript: (script) => ipcRenderer.invoke('browser:executeScript', script),

  // Recorder Controls
  startRecording: (name) => ipcRenderer.invoke('recorder:start', name),
  pauseRecording: () => ipcRenderer.invoke('recorder:pause'),
  resumeRecording: () => ipcRenderer.invoke('recorder:resume'),
  stopRecording: () => ipcRenderer.invoke('recorder:stop'),
  getStatus: () => ipcRenderer.invoke('recorder:getStatus'),
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
    }
  },

  // Event Subscriptions
  onNetworkEvent: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('network:event', handler);
    return () => ipcRenderer.removeListener('network:event', handler);
  },
  onBrowserState: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('browser:state', handler);
    return () => ipcRenderer.removeListener('browser:state', handler);
  }
});
