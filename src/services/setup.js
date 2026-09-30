'use strict';

/**
 * Auto-setup na primeira execução (multiplataforma: Windows, macOS, Linux).
 *
 * Responsabilidades:
 *   1. Detectar se o Ollama está instalado (PATH ou caminhos padrão do SO).
 *   2. Garantir que o servidor do Ollama esteja rodando ("ollama serve").
 *   3. Se o Ollama não existir, instalá-lo de acordo com o sistema:
 *        - Windows: baixa e roda o instalador oficial (.exe) em modo silencioso.
 *        - Linux:   roda o script oficial (curl -fsSL .../install.sh | sh).
 *        - macOS:   não há instalação silenciosa confiável; orientamos o
 *                   usuário a instalar (o app não trava por isso).
 *   4. Verificar/baixar o modelo padrão via /api/pull com progresso.
 *
 * Tudo local. A única necessidade de internet é na primeira vez.
 */

const { spawn, execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { app } = require('electron');

const OLLAMA_URL = 'http://127.0.0.1:11434';
const OLLAMA_INSTALLER_URL_WIN = 'https://ollama.com/download/OllamaSetup.exe';
const OLLAMA_INSTALL_SH = 'https://ollama.com/install.sh';
const OLLAMA_DOWNLOAD_PAGE = 'https://ollama.com/download';
const DEFAULT_MODEL = 'qwen2.5:7b';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// Caminhos comuns do executável do Ollama em cada sistema operacional.
function possibleOllamaPaths() {
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || '';
    const prog = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(local, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(prog, 'Ollama', 'ollama.exe'),
    ];
  }
  if (IS_MAC) {
    return [
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      '/Applications/Ollama.app/Contents/Resources/ollama',
    ];
  }
  // Linux
  return [
    '/usr/local/bin/ollama',
    '/usr/bin/ollama',
    path.join(os.homedir(), '.local', 'bin', 'ollama'),
  ];
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// Retorna o caminho do executável do ollama, ou null se não achar.
function findOllamaBinary() {
  for (const p of possibleOllamaPaths()) {
    if (fileExists(p)) return p;
  }
  return null;
}

// Verifica se o servidor HTTP do Ollama responde.
async function serverUp() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

// Lista os modelos instalados.
async function listModels() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

// Sobe "ollama serve" em segundo plano (se o binário existir).
function startServer() {
  const bin = findOllamaBinary() || 'ollama';
  try {
    const child = spawn(bin, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Aguarda o servidor ficar disponível, com timeout.
async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await serverUp()) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

// Baixa um arquivo por HTTPS, reportando progresso (0-100).
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, (res) => {
      // Segue redirecionamentos (o link do Ollama redireciona).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        return downloadFile(res.headers.location, destPath, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error('Falha no download: HTTP ' + res.statusCode));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total && onProgress) onProgress(Math.round((received / total) * 100));
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    });
    req.on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// Instala o Ollama de acordo com o sistema operacional.
async function installOllama(onProgress) {
  if (IS_WIN) return installOllamaWindows(onProgress);
  if (IS_LINUX) return installOllamaLinux(onProgress);
  if (IS_MAC) return installOllamaMac(onProgress);
  throw new Error('Sistema operacional não suportado para instalação automática.');
}

// --- Windows: baixa o instalador .exe e roda em modo silencioso ---
async function installOllamaWindows(onProgress) {
  const tmp = path.join(app.getPath('temp'), 'OllamaSetup.exe');
  onProgress && onProgress({ phase: 'download', percent: 0, message: 'Baixando o Ollama…' });
  await downloadFile(OLLAMA_INSTALLER_URL_WIN, tmp, (percent) =>
    onProgress && onProgress({ phase: 'download', percent, message: 'Baixando o Ollama…' })
  );

  onProgress && onProgress({ phase: 'install', percent: 100, message: 'Instalando o Ollama…' });
  await new Promise((resolve) => {
    // /VERYSILENT é aceito pelo instalador (Inno Setup) para instalação silenciosa.
    execFile(tmp, ['/VERYSILENT', '/NORESTART'], () => resolve());
  });

  await new Promise((r) => setTimeout(r, 4000));
  startServer();
  const ok = await waitForServer(30000);
  if (!ok) throw new Error('Ollama instalado, mas o serviço não respondeu. Reinicie o computador e abra o app de novo.');
  return true;
}

// --- Linux: usa o script oficial de instalação (curl | sh) ---
async function installOllamaLinux(onProgress) {
  onProgress && onProgress({ phase: 'install', percent: 50, message: 'Instalando o Ollama (script oficial)…' });
  await new Promise((resolve, reject) => {
    // Requer curl e permissão de sudo (o script pede a senha se necessário).
    const cmd = `curl -fsSL ${OLLAMA_INSTALL_SH} | sh`;
    exec(cmd, { shell: '/bin/bash' }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(
          'Não consegui instalar automaticamente no Linux. Rode no terminal:\n  curl -fsSL https://ollama.com/install.sh | sh\ne abra o app de novo. Detalhe: ' + (stderr || err.message)
        ));
      }
      resolve();
    });
  });

  await new Promise((r) => setTimeout(r, 3000));
  startServer();
  const ok = await waitForServer(30000);
  if (!ok) throw new Error('Ollama instalado, mas o serviço não respondeu. Rode "ollama serve" no terminal e reabra o app.');
  return true;
}

// --- macOS: não há instalação silenciosa confiável; orientar o usuário ---
async function installOllamaMac(onProgress) {
  // Se tiver Homebrew, tenta instalar por ele (melhor caminho automático no Mac).
  const temBrew = await new Promise((resolve) => {
    exec('command -v brew', { shell: '/bin/bash' }, (err, stdout) => resolve(!!(stdout && stdout.trim())));
  });

  if (temBrew) {
    onProgress && onProgress({ phase: 'install', percent: 50, message: 'Instalando o Ollama via Homebrew…' });
    const ok = await new Promise((resolve) => {
      exec('brew install ollama', { shell: '/bin/bash' }, (err) => resolve(!err));
    });
    if (ok) {
      startServer();
      if (await waitForServer(30000)) return true;
    }
  }

  // Sem Homebrew (ou falhou): pede instalação manual.
  throw new Error(
    'No macOS, instale o Ollama manualmente: baixe em ' + OLLAMA_DOWNLOAD_PAGE +
    ', arraste o Ollama para Aplicativos e abra-o uma vez. Depois volte aqui e clique em "Tentar de novo". (Ou instale o Homebrew e o app instala sozinho.)'
  );
}

// Baixa o modelo via /api/pull, transmitindo progresso.
async function pullModel(model, onProgress) {
  const nome = model || DEFAULT_MODEL;
  const res = await fetch(`${OLLAMA_URL}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: nome, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error('Não foi possível iniciar o download do modelo.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        let percent = 0;
        if (obj.total && obj.completed) {
          percent = Math.round((obj.completed / obj.total) * 100);
        }
        onProgress && onProgress({
          phase: 'model',
          percent,
          message: obj.status || 'Baixando modelo…',
        });
        if (obj.error) throw new Error(obj.error);
      } catch (e) {
        if (e.message && e.message !== 'Unexpected end of JSON input') {
          // ignora linhas parciais
        }
      }
    }
  }
  return true;
}

/**
 * Fluxo principal de verificação. Retorna o que ainda precisa ser feito,
 * sem executar as instalações (isso fica a cargo da UI/IPC dedicado).
 */
async function checkSetup(model = DEFAULT_MODEL) {
  const hasBinary = !!findOllamaBinary();

  // Se o servidor não está no ar, tenta subir (caso o binário exista).
  if (!(await serverUp())) {
    if (hasBinary) {
      startServer();
      await waitForServer(15000);
    }
  }

  const up = await serverUp();
  const models = up ? await listModels() : [];
  const hasModel = models.some((m) => m === model || m.startsWith(model));

  return {
    ollamaInstalled: hasBinary || up,
    serverUp: up,
    hasModel,
    models,
    model,
    ready: up && hasModel,
  };
}

module.exports = {
  checkSetup,
  installOllama,
  pullModel,
  startServer,
  waitForServer,
  serverUp,
  DEFAULT_MODEL,
};
