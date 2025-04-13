const { contextBridge } = require('electron');
const { dialog } = require('@electron/remote');
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

contextBridge.exposeInMainWorld('api', 
{
    ping: async () => 
    {
        const res = await fetch('http://127.0.0.1:8000/ping');
        return res.json();
    },

    mergeCsvFiles: async () => 
    {
        try 
        {
            const 
            { 
                canceled, filePaths } = await dialog.showOpenDialog({
                    properties: ['openFile', 'multiSelections'],
                    filters: 
                    [
                        { 
                            name: 'CSV and Text Files', extensions: ['csv', 'txt'] 
                        }
                    ]
                });

            if (canceled || filePaths.length === 0) 
                return null;

            let mergedData = [];
            let headers = null;

            for (const file of filePaths) 
            {
                const content = fs.readFileSync(file, 'utf8');
                const parsed = Papa.parse(content, { header: true });

                if (!parsed.meta.fields || parsed.data.length === 0) 
                {
                    throw new Error(`Invalid or empty file: ${file}`);
                }

                if (!headers) 
                {
                    headers = parsed.meta.fields;
                } 
                else 
                {
                    if (JSON.stringify(headers) !== JSON.stringify(parsed.meta.fields)) 
                    {
                        throw new Error(`Header mismatch in file: ${file}`);
                    }
                }

                mergedData = mergedData.concat(parsed.data);
            }

            return { headers, data: mergedData };
        } 
        catch (error) 
        {
            console.error('mergeCsvFiles error:', error);
            return null;
        }
    }
});