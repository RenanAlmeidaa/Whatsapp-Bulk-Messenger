const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // aqui você pode expor APIs se precisar (opcional)
});
