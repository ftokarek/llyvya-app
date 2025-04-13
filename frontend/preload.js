const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('api', 
{
    ping: async () => 
    {
        const res = await fetch('http://127.0.0.1:8000/ping');
        return res.json();
    }
});