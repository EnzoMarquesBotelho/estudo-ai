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

  // Exercícios por disciplina (Fase 3 — fixes). Padrão plan:generate/plan:progress.
  // O main lê os arquivos da disciplina SOB DEMANDA (economia de memória).
  exercisesByDiscipline: (args) => ipcRenderer.invoke('ex:byDiscipline', args), // { folder, discId, options }
  onExProgress: (cb) => {
    ipcRenderer.removeAllListeners('ex:progress');
    // Eventos possíveis no canal:
    //   leitura (handler): { phase:'read', current, total, name }
    //   map (ai):          { current, total, name, cached }   // SEM phase
    //   reduce (ai):       { phase:'reduce', message }
    ipcRenderer.on('ex:progress', (_e, data) => cb(data));
  },
  onAiProgress: (cb) => {
    ipcRenderer.removeAllListeners('ai:progress');
    ipcRenderer.on('ai:progress', (_e, data) => cb(data));
  },
  onAiToken: (cb) => {
    ipcRenderer.removeAllListeners('ai:token');
    ipcRenderer.on('ai:token', (_e, texto) => cb(texto));
  },

  // Agrupamento virtual por disciplina
  getGrouping: (folder) => ipcRenderer.invoke('grouping:get', folder),
  runGrouping: (args) => ipcRenderer.invoke('grouping:run', args),
  editGrouping: (args) => ipcRenderer.invoke('grouping:edit', args),
  suggestGroupingMode: (folder) => ipcRenderer.invoke('grouping:suggestMode', folder),
  onGroupingProgress: (cb) => {
    ipcRenderer.removeAllListeners('grouping:progress');
    ipcRenderer.on('grouping:progress', (_e, data) => cb(data));
  },

  // RAG — Perguntar sobre o acervo
  ragStatus: (args) => ipcRenderer.invoke('rag:status', args),
  ragIndex: (args) => ipcRenderer.invoke('rag:index', args),
  ragCancelIndex: () => ipcRenderer.invoke('rag:cancelIndex'),
  ragAsk: (args) => ipcRenderer.invoke('rag:ask', args),
  ragOpenSource: (args) => ipcRenderer.invoke('rag:openSource', args),
  onRagProgress: (cb) => {
    ipcRenderer.removeAllListeners('rag:progress');
    ipcRenderer.on('rag:progress', (_e, data) => cb(data));
  },

  // Classificação por tipo de material (Fase 3, Parte 1)
  getClassification: (folder) => ipcRenderer.invoke('classify:get', folder),
  runClassification: (args) => ipcRenderer.invoke('classify:run', args),       // { folder, fromScratch }
  setFileType: (args) => ipcRenderer.invoke('classify:set', args),             // { folder, path, tipo }
  clearFileType: (args) => ipcRenderer.invoke('classify:clear', args),         // { folder, path }
  cancelClassification: () => ipcRenderer.invoke('classify:cancel'),
  onClassifyProgress: (cb) => {
    ipcRenderer.removeAllListeners('classify:progress');
    ipcRenderer.on('classify:progress', (_e, data) => cb(data));              // lê data.name
  },

  // Plano de estudos / Modo prova (Fase 3, Parte 2)
  generatePlan: (args) => ipcRenderer.invoke('plan:generate', args),           // { folder, discId }
  onPlanProgress: (cb) => {
    ipcRenderer.removeAllListeners('plan:progress');
    ipcRenderer.on('plan:progress', (_e, data) => cb(data));                  // lê data.message
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

  // Atualização do app (GitHub)
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: () => ipcRenderer.invoke('update:apply'),
  updateOpenRepo: () => ipcRenderer.invoke('update:openRepo'),
  updateRestart: () => ipcRenderer.invoke('update:restart'),
  onUpdateProgress: (cb) => {
    ipcRenderer.removeAllListeners('update:progress');
    ipcRenderer.on('update:progress', (_e, data) => cb(data));
  },
});
