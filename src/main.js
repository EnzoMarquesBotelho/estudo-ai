'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./services/store');
const library = require('./services/library');
const watcher = require('./services/watcher');
const ai = require('./services/ai');
const grouping = require('./services/grouping');
const rag = require('./services/rag');
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
    title: 'CábulIA',
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

// ---- Agrupamento virtual por disciplina (100% virtual: nada no disco do usuário) ----
// Progresso do agrupamento (espelha sendAiProgress, canal próprio).
function sendGroupingProgress(p) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('grouping:progress', p);
  }
}

// Regra única de resolução/validação de pasta para os quatro handlers.
function resolveFolder(folder) {
  const root = folder || store.get('rootFolder');
  if (!root || !fs.existsSync(root)) return null;
  return root;
}

// Chamada genérica ao Ollama para o agrupamento (JSON, orçamento de saída maior).
const callGenerate = (prompt) =>
  ai.generate(prompt, {
    model: store.get('model') || undefined,
    json: true,
    numPredict: 1500,
  });

// Achata step1.disciplinas ([{ nome, arquivos }]) em [{ path, disciplina }].
function flattenToClassificados(step1) {
  const out = [];
  for (const d of (step1 && step1.disciplinas) || []) {
    for (const p of d.arquivos || []) out.push({ path: p, disciplina: d.nome });
  }
  return out;
}

// Monta o objeto de mapeamento inicial a partir do passo 1 (caminho full).
function buildFreshMapping(root, mode, step1) {
  const agora = Date.now();
  return {
    rootFolder: root,
    mode,
    disciplinas: ((step1 && step1.disciplinas) || []).map((d) => ({
      id: d.id,
      nome: d.nome,
      arquivos: (d.arquivos || []).slice(),
    })),
    generatedAt: agora,
    editedAt: agora,
    fileSignatures: {},
  };
}

// Conjunto final de arquivos para refreshSignatures (cobre invariante 4).
// full: só os válidos recebidos; incremental: antigos preservados + novos.
function filesDoMapping(mapping, valid, existing) {
  if (!existing) return valid.map((f) => ({ path: f.path, mtime: f.mtime || 0 }));
  const sigs = Object.assign({}, (existing.fileSignatures) || {});
  for (const f of valid) sigs[f.path] = f.mtime || 0;
  return Object.keys(sigs).map((p) => ({ path: p, mtime: sigs[p] }));
}

// Lê o mapeamento salvo da raiz. Retorna o objeto ou null.
ipcMain.handle('grouping:get', async (_evt, folder) => {
  const root = resolveFolder(folder);
  if (!root) return null;
  return grouping.loadMapping(root);
});

// Roda o agrupamento. args: { folder, files, mode, subtopics, fromScratch, runMode, removidos }
ipcMain.handle('grouping:run', async (_evt, args) => {
  const { files, mode: modeArg, subtopics, fromScratch, removidos } = args || {};
  const root = resolveFolder(args && args.folder);
  if (!root) return { ok: false, error: 'Pasta inválida.' };

  // Entrada: só itens com path:string e text:string (text pode ser '').
  const valid = (files || []).filter((f) => f && typeof f.path === 'string' && typeof f.text === 'string');
  if (!valid.length) return { ok: false, error: 'A pasta não tem arquivos legíveis.' };

  // runMode determinístico: fromScratch força full; incremental sem mapeamento salvo cai para full.
  const existing = fromScratch ? null : grouping.loadMapping(root);
  let runMode = args && args.runMode === 'incremental' ? 'incremental' : 'full';
  if (runMode === 'incremental' && !existing) runMode = 'full';

  const mode = (modeArg === 'porPasta' || modeArg === 'porConteudo')
    ? modeArg
    : grouping.suggestMode(library.scan(root)).sugerido;

  const textsByPath = Object.fromEntries(valid.map((f) => [f.path, f.text]));
  const signals = grouping.buildSignals(valid, textsByPath, root);
  const signalsByPath = Object.fromEntries(signals.map((s) => [s.path, s]));

  try {
    // ---- Passo 1: classificar os arquivos recebidos em disciplinas ----
    const disciplinasConhecidas = (runMode === 'incremental' && existing)
      ? existing.disciplinas.filter((d) => d.id !== grouping.ID_NAO_CLASSIFICADOS).map((d) => d.nome)
      : [];
    const step1 = (mode === 'porPasta')
      ? grouping.labelFromPorPasta(signals)
      : await grouping.classifyIntoDisciplinas(signals, {
        callGenerate, onProgress: sendGroupingProgress, disciplinasConhecidas,
      });

    // ---- Guarda de erro FATAL (Ollama offline no 1º lote) — ANTES de salvar ----
    if (step1 && step1.ok === false) {
      console.warn('[grouping:run] passo 1 fatal (offline):', step1.error);
      return { ok: false, error: step1.error || 'Falha ao agrupar.' };
    }

    // ---- Ramo full vs incremental ----
    let mapping, discIdsAfetados;
    if (runMode === 'incremental') {
      const m = grouping.pruneRemoved(existing, removidos || []);
      const classificados = flattenToClassificados(step1);
      const r = grouping.appendClassified(m, classificados);
      mapping = r.mapping;
      discIdsAfetados = r.discIdsAfetados;
    } else {
      mapping = buildFreshMapping(root, mode, step1);
      discIdsAfetados = null;
    }

    // ---- Passo 2 (opcional): tópicos ----
    if (subtopics) {
      mapping = await grouping.addTopicos(mapping, signalsByPath, {
        callGenerate, onProgress: sendGroupingProgress,
        alvo: discIdsAfetados, root,
      });
    }

    // ---- Invariante 4: assinaturas sobre o conjunto FINAL ----
    mapping = grouping.refreshSignatures(mapping, filesDoMapping(mapping, valid, existing));
    grouping.saveMapping(mapping);
    return { ok: true, mapping };
  } catch (e) {
    console.warn('[grouping:run] falhou:', e && e.message);
    return { ok: false, error: (e && e.userMessage) || (e && e.message) || 'Falha ao agrupar.' };
  }
});

// Aplica uma edição manual. args: { folder, op, params }
ipcMain.handle('grouping:edit', async (_evt, { folder, op, params } = {}) => {
  const root = resolveFolder(folder);
  if (!root) return { ok: false, error: 'Pasta inválida.' };

  const mapping = grouping.loadMapping(root);
  if (!mapping) return { ok: false, error: 'Esta pasta ainda não foi agrupada.' };

  const p = params || {};
  let res;
  switch (op) {
    case 'rename': {
      const nome = String(p.novoNome == null ? '' : p.novoNome).trim();
      if (!nome || nome.length > 80) return { ok: false, error: 'Nome inválido' };
      res = grouping.renameDisciplina(mapping, p.discId, nome);
      break;
    }
    case 'merge':
      res = grouping.mergeDisciplinas(mapping, p.sourceId, p.targetId);
      break;
    case 'move':
      res = grouping.moveArquivo(mapping, p.path, p.toDiscId);
      break;
    case 'create': {
      const nome = String(p.novoNome == null ? '' : p.novoNome).trim();
      if (!nome || nome.length > 80) return { ok: false, error: 'Nome inválido' };
      res = grouping.createDisciplina(mapping, nome);
      break;
    }
    default:
      return { ok: false, error: 'Operação inválida.' };
  }

  if (!res || res.ok === false) {
    console.warn('[grouping:edit] rejeitado:', op, res && res.error);
    return { ok: false, error: (res && res.error) || 'Falha na edição.' };
  }
  grouping.saveMapping(res.mapping);
  return { ok: true, mapping: res.mapping };
});

// Sugestão de modo a partir de um scan. Retorna { sugerido, motivo } ou { ok:false, error }.
ipcMain.handle('grouping:suggestMode', async (_evt, folder) => {
  const root = resolveFolder(folder);
  if (!root) return { ok: false, error: 'Pasta inválida.' };
  return grouping.suggestMode(library.scan(root));
});

// ---- RAG (Fase 2) — Perguntar sobre o acervo (100% local) ----
// Progresso da indexação (mesmo guarda de sendGroupingProgress).
function sendRagProgress(p) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rag:progress', p);
  }
}

// Injetores das chamadas ao Ollama para o núcleo rag.js. A temperature:0.2
// (anti-alucinação) vive SÓ aqui — rag.ask não a conhece.
const ragEmbed = (textos) => ai.embed(textos, { model: ai.DEFAULT_EMBED_MODEL });
const ragGenerate = (prompt, opts = {}) =>
  ai.generate(prompt, { model: store.get('model') || undefined, numPredict: 1200, temperature: 0.2, ...opts });

// Calcula quantos arquivos estão pendentes de (re)indexação lendo SÓ o
// .meta.json (nunca o índice completo). O meta carrega fileSignatures.
function calcPendentes(folder, scannedPaths) {
  const meta = rag.loadMeta(folder);
  if (!meta) return 0;
  const metaIndex = { fileSignatures: meta.fileSignatures || {} };
  const scan = Array.isArray(scannedPaths) ? scannedPaths : [];
  const diff = rag.diffForIndex(metaIndex, { scannedPaths: scan, files: scan });
  return diff.novos.length + diff.alterados.length + diff.removidos.length;
}

// Status do índice. Combina indexStatus (.meta.json), checkStatus e calcPendentes.
// Shape normativo único (design §2.5). exists:false => pendentes:0.
ipcMain.handle('rag:status', async (_evt, { folder, scannedPaths } = {}) => {
  const root = resolveFolder(folder);
  if (!root) return { exists: false, arquivos: 0, chunks: 0, modeloEmbedding: null, dim: null, generatedAt: null, embedModelInstalled: false, pendentes: 0 };

  const meta = rag.indexStatus(root);
  const status = await ai.checkStatus();
  const embedModelInstalled = !!(status.ok && rag.hasEmbedModel(status.models, ai.DEFAULT_EMBED_MODEL));
  const pendentes = meta.exists ? calcPendentes(root, scannedPaths) : 0;
  return Object.assign({}, meta, { embedModelInstalled, pendentes });
});

// Indexa a pasta. args: { folder, files, scannedPaths, fromScratch }.
ipcMain.handle('rag:index', async (_evt, { folder, files, scannedPaths, fromScratch } = {}) => {
  const root = resolveFolder(folder);
  if (!root) return { ok: false, error: 'Pasta inválida.' };

  // Pré-condição na ORDEM NORMATIVA: checar status.ok ANTES de embedModelInstalled.
  const status = await ai.checkStatus();
  if (!status.ok) {
    return { ok: false, error: 'Ollama não está rodando. Abra o Ollama e tente de novo.' };
  }
  if (!rag.hasEmbedModel(status.models, ai.DEFAULT_EMBED_MODEL)) {
    return { ok: false, error: 'EMBED_MODEL_AUSENTE' };
  }

  // Validação de entradas: files aceita text:'' (arquivo ilegível).
  const validFiles = (files || []).filter((f) => f && typeof f.path === 'string' && typeof f.text === 'string');
  const validScan = (scannedPaths || []).filter((s) => s && typeof s.path === 'string');
  if (!validFiles.length && !validScan.length) {
    return { ok: false, error: 'A pasta não tem arquivos.' };
  }

  try {
    return await rag.indexFiles({
      rootFolder: root,
      files: validFiles,
      scannedPaths: validScan,
      fromScratch: !!fromScratch,
      embed: ragEmbed,
      embedModel: ai.DEFAULT_EMBED_MODEL,
      onProgress: sendRagProgress,
    });
  } catch (e) {
    console.warn('[rag:index] falhou:', e && e.message);
    return { ok: false, error: (e && e.message) || 'Falha ao indexar.' };
  }
});

// Responde a uma pergunta. args: { folder, pergunta, scope, discId? }.
ipcMain.handle('rag:ask', async (_evt, { folder, pergunta, scope, discId } = {}) => {
  const root = resolveFolder(folder);
  if (!root) return { ok: false, error: 'Pasta inválida.' };

  let texto = typeof pergunta === 'string' ? pergunta.trim() : '';
  if (!texto) return { ok: false, error: 'Digite uma pergunta.' };
  if (texto.length > rag.MAX_PERGUNTA_CHARS) texto = texto.slice(0, rag.MAX_PERGUNTA_CHARS);

  let scopePaths = null;
  if (scope === 'disciplina') {
    const mapping = grouping.loadMapping(root);
    const disc = mapping && (mapping.disciplinas || []).find((d) => d.id === discId);
    if (!disc) return { ok: false, error: 'Disciplina não encontrada.' };
    scopePaths = disc.arquivos || [];
  }

  try {
    return await rag.ask({ rootFolder: root, pergunta: texto, scopePaths, embed: ragEmbed, generate: ragGenerate });
  } catch (e) {
    console.warn('[rag:ask] falhou:', e && e.message);
    return { ok: false, error: (e && e.message) || 'Falha ao responder.' };
  }
});

// Abre o arquivo de uma fonte citada. args: { folder, path }.
// Valida contra o .meta.json da pasta corrente (não abre caminho arbitrário).
ipcMain.handle('rag:openSource', async (_evt, { folder, path: filePath } = {}) => {
  const root = resolveFolder(folder);
  if (!root) return { ok: false, error: 'Pasta inválida.' };

  const meta = rag.loadMeta(root);
  const conhecidos = new Set((meta && meta.paths) || []);
  const alvo = path.normalize(String(filePath || ''));
  const casa = conhecidos.has(filePath) || Array.from(conhecidos).some((p) => path.normalize(p) === alvo);
  if (!casa) {
    console.warn('[rag:openSource] path fora do índice:', filePath);
    return { ok: false, error: 'Arquivo não encontrado.' };
  }
  const err = await shell.openPath(filePath);
  return err ? { ok: false, error: err } : { ok: true };
});

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

// ---- Atualização do app (via GitHub) ----
// Verifica se há uma versão mais nova no GitHub (só precisa de internet).
ipcMain.handle('update:check', async () => {
  try {
    return await updater.checkForUpdates();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Aplica a atualização localmente (git pull + npm install), com progresso.
ipcMain.handle('update:apply', async () => {
  try {
    return await updater.applyUpdate((p) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:progress', p);
      }
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Abre a página do projeto no navegador (fallback para versão empacotada).
ipcMain.handle('update:openRepo', async () => {
  shell.openExternal(updater.REPO_URL);
  return { ok: true };
});

// Reinicia o app para carregar a versão recém-atualizada.
ipcMain.handle('update:restart', async () => {
  // Fecha o monitoramento de arquivos antes de sair.
  try { watcher.stop(); } catch {}
  app.relaunch();
  app.exit(0);
  return { ok: true };
});
