const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  mergeCsvFiles: async () => {
    const result = await ipcRenderer.invoke('open-file-dialog');
    return result;
  },

  processFiles: async (config) => {
    const result = await ipcRenderer.invoke('process-files', config);
    if (result && result.success) {
      alert('File saved successfully!');
    } else {
      alert('Something went wrong while processing the files.');
    }
  }
});