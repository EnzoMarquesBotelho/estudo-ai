'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expõe uma API mínima e segura para o renderer.
// O renderer NUNCA acessa Node/fs diretamente — só através destes canais.
contextBridge.exposeInMainWorld('api', {
  // Pasta
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  getSavedFolder: () => ipcRenderer.invoke('folder:getSaved'),

  // Biblioteca
  scanLibrary: (folder) => ipcRenderer.invoke('library:scan', folder),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),

  // Watcher
  startWatch: (folder) => ipcRenderer.invoke('watch:start', folder),
  onLibraryChanged: (cb) => {
    ipcRenderer.removeAllListeners('library:changed');
    ipcRenderer.on('library:changed', () => cb());
  },

  // IA
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  summary: (text, options) => ipcRenderer.invoke('ai:summary', { text, options }),
  mindmap: (text, options) => ipcRenderer.invoke('ai:mindmap', { text, options }),
  exercises: (text, options) => ipcRenderer.invoke('ai:exercises', { text, options }),

  // Versões de pasta inteira (map-reduce)
  summaryFolder: (files, options) => ipcRenderer.invoke('ai:summaryFolder', { files, options }),
  mindmapFolder: (files, options) => ipcRenderer.invoke('ai:mindmapFolder', { files, options }),
  exercisesFolder: (files, options) => ipcRenderer.invoke('ai:exercisesFolder', { files, options }),
  onAiProgress: (cb) => {
    ipcRenderer.removeAllListeners('ai:progress');
    ipcRenderer.on('ai:progress', (_e, data) => cb(data));
  },
  onAiToken: (cb) => {
    ipcRenderer.removeAllListeners('ai:token');
    ipcRenderer.on('ai:token', (_e, texto) => cb(texto));
  },

  // Exportar
  exportSave: (title, kind, payload) =>
    ipcRenderer.invoke('export:save', { title, kind, payload }),

  // Cache local
  cacheGet: (key) => ipcRenderer.invoke('cache:get', key),
  cacheSet: (key, value) => ipcRenderer.invoke('cache:set', { key, value }),

  // Auto-setup (primeira execução)
  setupCheck: () => ipcRenderer.invoke('setup:check'),
  setupInstallOllama: () => ipcRenderer.invoke('setup:installOllama'),
  setupPullModel: (model) => ipcRenderer.invoke('setup:pullModel', model),
  onSetupProgress: (cb) => {
    ipcRenderer.removeAllListeners('setup:progress');
    ipcRenderer.on('setup:progress', (_e, data) => cb(data));
  },

  // Seleção e download de modelos
  getModel: () => ipcRenderer.invoke('model:get'),
  setModel: (model) => ipcRenderer.invoke('model:set', model),
  pullModel: (model) => ipcRenderer.invoke('model:pull', model),

  // Auto-atualização (avisos)
  onUpdateStatus: (cb) => {
    ipcRenderer.removeAllListeners('update:status');
    ipcRenderer.on('update:status', (_e, data) => cb(data));
  },
});
