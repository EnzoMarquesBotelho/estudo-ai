'use strict';

/**
 * Persistência local simples baseada em um arquivo JSON dentro da pasta
 * de dados do usuário (userData do Electron). Guarda configurações
 * (pasta selecionada) e um cache dos resultados gerados pela IA.
 * Nada sai da máquina.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Usa a pasta de dados do Electron quando disponível. Fora do Electron
// (ex.: rodando testes com "node"), cai para uma pasta na temp do sistema,
// para que os módulos que dependem do store possam ser reutilizados.
function resolveDataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch {}
  const dir = path.join(os.tmpdir(), 'estudo-ai-data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[store] falha ao gravar', file, e.message);
    return false;
  }
}

let config = readJson(CONFIG_FILE, {});
let cache = readJson(CACHE_FILE, {});

module.exports = {
  get(key) {
    return config[key];
  },
  set(key, value) {
    config[key] = value;
    writeJson(CONFIG_FILE, config);
    return value;
  },
  getCache(key) {
    return cache[key] || null;
  },
  setCache(key, value) {
    cache[key] = value;
    writeJson(CACHE_FILE, cache);
    return true;
  },
};
