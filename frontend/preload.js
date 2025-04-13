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
  },

  mergeCsvFilesFromDrop: async (filePaths) => {
    const result = await ipcRenderer.invoke('merge-csv-files-from-drop', filePaths);
    return result;
  },

  getXlsxSheets: async (filePath) => {
    const sheets = await ipcRenderer.invoke('get-xlsx-sheets', filePath);
    return sheets;
  }
});