'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./services/store');
const library = require('./services/library');
const watcher = require('./services/watcher');
const ai = require('./services/ai');
const exporter = require('./services/exporter');
const setup = require('./services/setup');
const updater = require('./services/updater');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e2e',
    title: 'Estudo AI',
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Segurança: nunca abrir novas janelas / navegar para fora.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    watcher.stop();
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  // Auto-atualização (só quando empacotado e com "publish" configurado).
  updater.init(app, () => mainWindow, console);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC — ponte entre a interface (renderer) e o sistema/serviços (main).
// Toda operação de disco e IA acontece aqui no processo principal.
// ---------------------------------------------------------------------------

// Selecionar a pasta de estudos
ipcMain.handle('folder:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione a pasta de estudos',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const folder = res.filePaths[0];
  store.set('rootFolder', folder);
  return folder;
});

// Recuperar a pasta salva anteriormente
ipcMain.handle('folder:getSaved', async () => store.get('rootFolder') || null);

// Ler a biblioteca (notebooks + arquivos) da pasta
ipcMain.handle('library:scan', async (_evt, folder) => {
  const root = folder || store.get('rootFolder');
  if (!root || !fs.existsSync(root)) return { notebooks: [] };
  return library.scan(root);
});

// Ler o texto de um arquivo específico
ipcMain.handle('file:read', async (_evt, filePath) => {
  return library.readFileText(filePath);
});

// Iniciar o monitoramento da pasta (auto-atualização)
ipcMain.handle('watch:start', async (_evt, folder) => {
  const root = folder || store.get('rootFolder');
  if (!root) return false;
  watcher.start(root, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:changed');
    }
  });
  return true;
});

// ---- IA (Ollama local) ----
ipcMain.handle('ai:status', async () => ai.checkStatus());

// Envia o texto parcial (streaming) para a interface mostrar em tempo real.
function sendAiToken(texto) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ai:token', texto);
  }
}

ipcMain.handle('ai:summary', async (_evt, { text, options }) =>
  ai.generateSummary(text, { ...options, onToken: sendAiToken })
);

ipcMain.handle('ai:mindmap', async (_evt, { text, options }) =>
  ai.generateMindmap(text, options)
);

ipcMain.handle('ai:exercises', async (_evt, { text, options }) =>
  ai.generateExercises(text, { ...options, onToken: sendAiToken })
);

// ---- Versões de PASTA INTEIRA (map-reduce, com progresso) ----
function sendAiProgress(p) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ai:progress', p);
  }
}

ipcMain.handle('ai:summaryFolder', async (_evt, { files, options }) =>
  ai.generateSummaryFolder(files, { ...options, onToken: sendAiToken }, sendAiProgress)
);

ipcMain.handle('ai:mindmapFolder', async (_evt, { files, options }) =>
  ai.generateMindmapFolder(files, options, sendAiProgress)
);

ipcMain.handle('ai:exercisesFolder', async (_evt, { files, options }) =>
  ai.generateExercisesFolder(files, { ...options, onToken: sendAiToken }, sendAiProgress)
);

// ---- Exportação / compartilhamento ----
ipcMain.handle('export:save', async (_evt, { title, kind, payload }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar',
    defaultPath: exporter.suggestFilename(title, kind),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'HTML', extensions: ['html'] },
    ],
  });
  if (res.canceled || !res.filePath) return null;
  return exporter.save(res.filePath, kind, payload);
});

// Persistência dos resultados gerados (cache local)
ipcMain.handle('cache:get', async (_evt, key) => store.getCache(key));
ipcMain.handle('cache:set', async (_evt, { key, value }) => store.setCache(key, value));

// ---- Modelo de IA escolhido ----
ipcMain.handle('model:get', async () => store.get('model') || null);
ipcMain.handle('model:set', async (_evt, model) => store.set('model', model));

// Baixa um modelo qualquer sob demanda (com progresso), reaproveitando o setup.
ipcMain.handle('model:pull', async (_evt, model) => {
  try {
    await setup.pullModel(model, (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('setup:progress', p);
      }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- Auto-setup na primeira execução ----
ipcMain.handle('setup:check', async () => setup.checkSetup());

ipcMain.handle('setup:installOllama', async () => {
  try {
    await setup.installOllama((p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('setup:progress', p);
      }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('setup:pullModel', async (_evt, model) => {
  try {
    await setup.pullModel(model, (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('setup:progress', p);
      }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
