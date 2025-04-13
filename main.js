const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Papa = require('papaparse');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const os = require('os');

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
      { name: 'Data Files', extensions: ['csv', 'txt', 'tsv', 'xlsx', 'json', 'zip'] }
    ]
  });

  return {
    canceled: result.canceled,
    files: result.canceled ? [] : result.filePaths
  };
});

ipcMain.handle('process-files', async (event, config) => {
  try {
    let expandedFiles = [];

    for (const f of config.files) {
      const ext = path.extname(f.file || '').toLowerCase();

      if (ext === '.zip') {
        const zip = new AdmZip(f.file);
        const tempDir = path.join(os.tmpdir(), `unzip-${Date.now()}`);
        zip.extractAllTo(tempDir, true);

        const extracted = fs.readdirSync(tempDir).map(name => path.join(tempDir, name));
        const supportedExts = ['.csv', '.txt', '.tsv', '.xlsx', '.json'];

        extracted.forEach(ef => {
          const fileExt = path.extname(ef).toLowerCase();
          const isFile = fs.statSync(ef).isFile();
          const isSupported = supportedExts.includes(fileExt);
          if (isFile && isSupported) {
            expandedFiles.push({ file: ef, header: 'yes', dedup: 'no' });
          }
        });
      } else {
        expandedFiles.push(f);
      }
    }

    config.files = expandedFiles;

    let allHeaders = [];
    let dataByFile = [];
    let dotCount = 0, commaCount = 0;

    for (const fileConfig of config.files) {
      const ext = path.extname(fileConfig.file).toLowerCase();
      let data = [];
      let fileHeaders = null;

      if (['.csv', '.txt', '.tsv'].includes(ext)) {
        const content = fs.readFileSync(fileConfig.file, 'utf8');
        const parsed = Papa.parse(content, {
          header: fileConfig.header === 'yes',
          skipEmptyLines: true,
          delimiter: ext === '.tsv' ? '\t' : undefined
        });

        if (fileConfig.header === 'no') {
          fileHeaders = parsed.data[0].map((_, i) => `Column ${i + 1}`);
          data = parsed.data.map(row => {
            const obj = {};
            fileHeaders.forEach((key, i) => {
              obj[key] = row[i];
            });
            return obj;
          });
        } else {
          fileHeaders = parsed.meta.fields;
          data = parsed.data;
        }

      } else if (ext === '.xlsx') {
        const workbook = XLSX.readFile(fileConfig.file);
        const selectedSheets = fileConfig.sheets;

        if (!Array.isArray(selectedSheets) || selectedSheets.length === 0) {
          console.warn(`No sheets selected for: ${fileConfig.file}`);
          continue;
        }

        for (const sheetName of selectedSheets) {
          if (!workbook.SheetNames.includes(sheetName)) {
            console.warn(`Sheet ${sheetName} not found in ${fileConfig.file}`);
            continue;
          }

          const sheet = workbook.Sheets[sheetName];
          const hasHeader = fileConfig.sheetHeader?.[sheetName] === 'yes';
          let sheetData, headers;

          if (hasHeader) {
            sheetData = XLSX.utils.sheet_to_json(sheet, { defval: '' });
            headers = Object.keys(sheetData[0] || {});
          } else {
            const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            headers = raw[0].map((_, i) => `Column ${i + 1}`);
            sheetData = raw.map(row => {
              const obj = {};
              headers.forEach((key, i) => {
                obj[key] = row[i];
              });
              return obj;
            });
          }

          allHeaders.push({ file: `${fileConfig.file}::${sheetName}`, headers });
          dataByFile.push({
            data: sheetData,
            dedup: fileConfig.sheetDedup?.[sheetName] === 'yes',
            label: `${fileConfig.file}::${sheetName}`,
            header: hasHeader ? 'yes' : 'no'
          });
        }

        continue; // skip push below
      } else if (ext === '.json') {
        const raw = fs.readFileSync(fileConfig.file, 'utf8');
        data = JSON.parse(raw);
        fileHeaders = Object.keys(data[0] || {});
      } else {
        console.warn(`Unsupported file format: ${fileConfig.file}`);
        continue;
      }

      allHeaders.push({ file: fileConfig.file, headers: fileHeaders });
      dataByFile.push({ data, dedup: fileConfig.dedup });
    }

    // override global headers if at least one XLSX source had headers
    const firstHeaderSourceWithHeaders = allHeaders.find(h => h.headers && h.headers.length && h.file.includes('::') && h.header === 'yes');
    if (firstHeaderSourceWithHeaders) {
      headers = firstHeaderSourceWithHeaders.headers;
    }

    // check if headers are consistent
    const firstHeader = allHeaders[0].headers;
    const headersDiffer = allHeaders.some(h => JSON.stringify(h.headers) !== JSON.stringify(firstHeader));
    const equalColumnCounts = allHeaders.every(h => h.headers.length === firstHeader.length);

    let headers = firstHeader;

    if (headersDiffer && equalColumnCounts) {
      const confirmMerge = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 0,
        message: 'Headers differ between files. Do you want to merge anyway?'
      });

      if (confirmMerge.response === 1) {
        return { success: false };
      }

      const choice = await dialog.showMessageBox({
        type: 'question',
        buttons: allHeaders.map(h => path.basename(h.file)),
        message: 'Choose which file\'s headers should be used in the final file.'
      });

      headers = allHeaders[choice.response].headers;
    }

    let mergedData = [];
    for (let i = 0; i < dataByFile.length; i++) {
      let data = dataByFile[i].data;
      const dedup = dataByFile[i].dedup === 'yes';

      data = data.map(row => {
        const newRow = {};
        headers.forEach((key, i) => {
          const val = Object.values(row)[i];
          newRow[key] = val;
        });
        return newRow;
      });

      if (dedup) {
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

    for (const file of dataByFile) {
      for (const row of file.data) {
        for (const key in row) {
          const val = row[key];
          if (typeof val === 'string') {
            if (val.match(/^\d+,\d+$/)) commaCount++;
            if (val.match(/^\d+\.\d+$/)) dotCount++;
          }
        }
      }
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

    if (config.cleanup) {
      const normalizeValues = ['null', 'NULL', 'n/a', 'N/A', '-', '(blank)'];

      if (config.cleanup.trimSpaces === 'yes' || config.cleanup.normalizeMissing === 'yes') {
        mergedData = mergedData.map(row => {
          const newRow = {};
          for (const key in row) {
            let val = row[key];
            if (typeof val === 'string') {
              if (config.cleanup.trimSpaces === 'yes') {
                val = val.trim();
              }
              if (config.cleanup.normalizeMissing === 'yes' && normalizeValues.includes(val)) {
                val = '';
              }
            }
            newRow[key] = val;
          }
          return newRow;
        });
      }

      if (config.cleanup.removeEmptyColumns === 'yes' && mergedData.length > 0) {
        const allKeys = Object.keys(mergedData[0]);
        const keysToKeep = allKeys.filter(key =>
          mergedData.some(row => {
            const val = row[key];
            return val !== '' && val !== null && val !== undefined;
          })
        );
        mergedData = mergedData.map(row => {
          const newRow = {};
          keysToKeep.forEach(key => {
            newRow[key] = row[key];
          });
          return newRow;
        });
      }
    }

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
        if (typeof val === 'string' || typeof val === 'number') {
          let raw = String(val).replace(',', '.');
          let num = Number(raw);
          if (!isNaN(num) && isFinite(num)) {
            let formatted = num.toFixed(maxPrecision);
            val = useComma ? formatted.replace('.', ',') : formatted;
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

ipcMain.handle('get-xlsx-sheets', async (event, filePath) => {
  try {
    const workbook = XLSX.readFile(filePath);
    return workbook.SheetNames;
  } catch (error) {
    console.error('get-xlsx-sheets error:', error);
    return [];
  }
});