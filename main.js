const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Papa = require('papaparse');
const XLSX = require('xlsx');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'frontend', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'frontend', 'index.html'));
}

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Data Files', extensions: ['csv', 'txt', 'tsv', 'xlsx', 'json'] }
    ]
  });

  return {
    canceled: result.canceled,
    files: result.canceled ? [] : result.filePaths
  };
});

ipcMain.handle('process-files', async (event, config) => {
  try {
    let mergedData = [];
    let headers = null;
    let dotCount = 0;
    let commaCount = 0;

    for (const fileConfig of config.files) {
      const content = fs.readFileSync(fileConfig.file, 'utf8');

      const parsed = Papa.parse(content, {
        header: fileConfig.header === 'yes',
        skipEmptyLines: true
      });

      let data = parsed.data;

      if (fileConfig.header === 'no') {
        if (!headers) {
          headers = parsed.data[0].map((_, i) => `Column ${i + 1}`);
        }

        data = parsed.data.map(row => {
          const obj = {};
          headers.forEach((key, i) => {
            obj[key] = row[i];
          });
          return obj;
        });
      } else {
        if (!headers) {
          headers = parsed.meta.fields;
        } else if (JSON.stringify(headers) !== JSON.stringify(parsed.meta.fields)) {
          console.warn(`Header mismatch in file: ${fileConfig.file}`);
        }
      }

      if (fileConfig.dedup === 'yes') {
        const seen = new Set();
        data = data.filter(row => {
          const key = JSON.stringify(row);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      mergedData = mergedData.concat(data);
    }

    let maxPrecision = 0;
    mergedData.forEach(row => {
      for (const key in row) {
        const val = row[key];
        if (typeof val === 'string') {
          const match = val.match(/^\d+[.,](\d+)$/);
          if (match) {
            const precision = match[1].length;
            if (precision > maxPrecision) maxPrecision = precision;
          }
        }
      }
    });

    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Comma (1,50)', 'Dot (1.50)'],
      defaultId: dotCount > commaCount ? 1 : 0,
      message: 'Which decimal notation would you like to use in the final file?'
    });
    const useComma = response === 0;

    mergedData = mergedData.map(row => {
      const newRow = {};
      for (const key in row) {
        let val = row[key];
        if (typeof val === 'string') {
          if (val.match(/^\d+[.,]\d+$/)) {
            let num = val.replace(',', '.');
            if (!isNaN(parseFloat(num))) {
              val = parseFloat(num).toFixed(maxPrecision).replace('.', useComma ? ',' : '.');
            }
          }
        }
        newRow[key] = val;
      }
      return newRow;
    });

    if (config.outputFormat === 'xlsx' && mergedData.length > 1048576) {
      const confirm = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Continue anyway', 'Cancel and choose different format'],
        defaultId: 1,
        message: `XLSX format supports up to 1,048,576 rows.\n\nYour merged file has ${mergedData.length} rows.\nRows beyond this limit will be lost.\n\nDo you still want to continue?`
      });

      if (confirm.response === 1) {
        return { success: false };
      }

      mergedData = mergedData.slice(0, 1048576);
    }

    const { filePath } = await dialog.showSaveDialog({
      title: 'Save merged file',
      defaultPath: `merged.${config.outputFormat}`,
      filters: [
        { name: 'Export File', extensions: [config.outputFormat] }
      ]
    });

    if (!filePath) return { success: false };

    let output = '';
    if (config.outputFormat === 'csv') {
      output = Papa.unparse(mergedData);
      fs.writeFileSync(filePath, output, 'utf8');
    } else if (config.outputFormat === 'tsv' || config.outputFormat === 'txt') {
      output = Papa.unparse(mergedData, { delimiter: '\t' });
      fs.writeFileSync(filePath, output, 'utf8');
    } else if (config.outputFormat === 'json') {
      output = JSON.stringify(mergedData, null, 2);
      fs.writeFileSync(filePath, output, 'utf8');
    } else if (config.outputFormat === 'xlsx') {
      const worksheet = XLSX.utils.json_to_sheet(mergedData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
      XLSX.writeFile(workbook, filePath);
    } else {
      return { success: false };
    }

    return { success: true };
  } catch (err) {
    console.error('process-files error:', err);
    return { success: false };
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});