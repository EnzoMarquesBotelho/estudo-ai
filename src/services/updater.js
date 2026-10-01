'use strict';

/**
 * Atualizador do Estudo AI (multiplataforma).
 *
 * Objetivos:
 *   1. NOTIFICAR dentro do app quando houver uma versão mais nova no GitHub.
 *   2. APLICAR a atualização localmente (git pull + npm install) quando o app
 *      estiver instalado como repositório git e o git estiver disponível.
 *
 * Como a verificação funciona:
 *   - Lê o commit local (de .git ou via "git rev-parse HEAD").
 *   - Consulta a API pública do GitHub pelo commit mais recente da branch.
 *   - Compara os dois. Se forem diferentes, há atualização disponível.
 *
 * A verificação só precisa de internet (não exige git instalado). Aplicar a
 * atualização, sim, exige git + a pasta .git (versão instalada via clone).
 * Para a versão empacotada (.exe), apenas notificamos e abrimos o GitHub.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

// Dono/repo e branch padrão. Derivados do remote origin deste projeto.
const REPO_OWNER = 'EnzoMarquesBotelho';
const REPO_NAME = 'estudo-ai';
const DEFAULT_BRANCH = 'main';
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

// Raiz do app: duas pastas acima deste arquivo (src/services -> raiz).
const APP_ROOT = path.resolve(__dirname, '..', '..');
const GIT_DIR = path.join(APP_ROOT, '.git');

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

// Executa um comando e resolve { ok, stdout, stderr }. Nunca lança.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: APP_ROOT, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        error: err ? err.message : null,
      });
    });
  });
}

// O app foi instalado como repositório git?
function isGitRepo() {
  try {
    return fs.existsSync(GIT_DIR);
  } catch {
    return false;
  }
}

// GET JSON na API do GitHub (com User-Agent, exigido pela API).
function githubJson(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: 'api.github.com',
        path: apiPath,
        headers: {
          'User-Agent': 'estudo-ai-updater',
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('GitHub respondeu ' + res.statusCode));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Resposta inválida do GitHub.'));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('tempo esgotado ao falar com o GitHub')));
  });
}

// ---------------------------------------------------------------------------
// Commit local
// ---------------------------------------------------------------------------

// Lê o SHA do commit local. Tenta via git; se falhar, lê direto do .git.
async function localCommit() {
  // Caminho preferido: git rev-parse (confiável).
  const r = await run('git', ['rev-parse', 'HEAD']);
  if (r.ok && /^[0-9a-f]{40}$/i.test(r.stdout)) return r.stdout;

  // Fallback sem git: lê .git/HEAD e resolve a ref.
  try {
    const head = fs.readFileSync(path.join(GIT_DIR, 'HEAD'), 'utf-8').trim();
    const m = head.match(/^ref:\s*(.+)$/);
    if (!m) return head; // HEAD destacado: já é um SHA
    const refPath = path.join(GIT_DIR, m[1]);
    if (fs.existsSync(refPath)) {
      return fs.readFileSync(refPath, 'utf-8').trim();
    }
    // Pode estar empacotado em packed-refs.
    const packed = path.join(GIT_DIR, 'packed-refs');
    if (fs.existsSync(packed)) {
      const linhas = fs.readFileSync(packed, 'utf-8').split('\n');
      for (const l of linhas) {
        const pm = l.match(/^([0-9a-f]{40})\s+(.+)$/i);
        if (pm && pm[2] === m[1]) return pm[1];
      }
    }
  } catch {}
  return null;
}

// Descobre a branch atual (fallback para a padrão).
async function currentBranch() {
  const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.ok && r.stdout && r.stdout !== 'HEAD') return r.stdout;
  return DEFAULT_BRANCH;
}

// ---------------------------------------------------------------------------
// Verificação de atualização
// ---------------------------------------------------------------------------

/**
 * Verifica se há atualização no GitHub.
 * Retorna:
 *   { ok, updateAvailable, behind, localSha, remoteSha, branch,
 *     canApply, repoUrl, message }
 * ou { ok:false, error } em caso de falha de rede.
 */
async function checkForUpdates() {
  const gitRepo = isGitRepo();
  const branch = gitRepo ? await currentBranch() : DEFAULT_BRANCH;

  let remoteSha;
  try {
    const info = await githubJson(`/repos/${REPO_OWNER}/${REPO_NAME}/commits/${branch}`);
    remoteSha = info && info.sha;
  } catch (e) {
    return { ok: false, error: 'Não consegui verificar atualizações: ' + e.message, repoUrl: REPO_URL };
  }
  if (!remoteSha) {
    return { ok: false, error: 'GitHub não retornou o commit mais recente.', repoUrl: REPO_URL };
  }

  const localSha = gitRepo ? await localCommit() : null;

  // Sem commit local conhecido (ex.: versão .exe empacotada): não dá para
  // comparar com precisão. Informamos que a checagem só vale para a versão git.
  if (!localSha) {
    return {
      ok: true,
      updateAvailable: false,
      unknownLocal: true,
      remoteSha,
      localSha: null,
      branch,
      canApply: false,
      repoUrl: REPO_URL,
      message:
        'Não consegui identificar sua versão local (esta cópia não é um repositório git). ' +
        'Para receber atualizações automáticas, use a versão instalada via Git.',
    };
  }

  const updateAvailable = localSha !== remoteSha;

  // Quantos commits atrás estamos (mensagem mais amigável). Best-effort.
  let behind = 0;
  if (updateAvailable) {
    try {
      const cmp = await githubJson(
        `/repos/${REPO_OWNER}/${REPO_NAME}/compare/${localSha}...${remoteSha}`
      );
      behind = (cmp && cmp.ahead_by) || 0;
    } catch {
      behind = 0; // não crítico
    }
  }

  // Só conseguimos aplicar se for repo git. (git instalado é checado no apply.)
  const canApply = gitRepo;

  return {
    ok: true,
    updateAvailable,
    behind,
    localSha,
    remoteSha,
    branch,
    canApply,
    repoUrl: REPO_URL,
    message: updateAvailable
      ? (behind > 0
          ? `Há ${behind} atualização(ões) nova(s) disponível(is).`
          : 'Há uma nova versão disponível.')
      : 'Você já está na versão mais recente.',
  };
}

// ---------------------------------------------------------------------------
// Aplicar atualização (git pull + npm install)
// ---------------------------------------------------------------------------

// Verifica se o git está disponível no PATH.
async function hasGit() {
  const r = await run('git', ['--version']);
  return r.ok;
}

/**
 * Aplica a atualização localmente. Reporta progresso via onProgress({phase,message}).
 * Retorna { ok } ou { ok:false, error }.
 */
async function applyUpdate(onProgress) {
  const say = (phase, message) => onProgress && onProgress({ phase, message });

  if (!isGitRepo()) {
    return {
      ok: false,
      error: 'Esta cópia não é um repositório git, então não dá para atualizar automaticamente. Baixe a versão nova em ' + REPO_URL,
      repoUrl: REPO_URL,
    };
  }
  if (!(await hasGit())) {
    return {
      ok: false,
      error: 'O Git não está instalado. Instale em https://git-scm.com e tente de novo (ou use o arquivo ATUALIZAR).',
      repoUrl: REPO_URL,
    };
  }

  const branch = await currentBranch();

  say('fetch', 'Buscando novidades no GitHub…');
  const fetched = await run('git', ['fetch', '--quiet']);
  if (!fetched.ok) {
    return { ok: false, error: 'Falha ao falar com o GitHub: ' + (fetched.stderr || fetched.error) };
  }

  // Guarda alterações locais não salvas para não bloquear o pull.
  const dirty = await run('git', ['diff', '--quiet']);
  let stashed = false;
  if (!dirty.ok) {
    say('stash', 'Guardando alterações locais…');
    const s = await run('git', ['stash', 'push', '-u', '-m', 'estudo-ai-auto-update']);
    stashed = s.ok;
  }

  say('pull', 'Aplicando a atualização…');
  const pulled = await run('git', ['pull', '--ff-only', 'origin', branch]);
  if (!pulled.ok) {
    if (stashed) await run('git', ['stash', 'pop']);
    return {
      ok: false,
      error: 'Não consegui aplicar a atualização (possível conflito com alterações locais). ' + (pulled.stderr || ''),
    };
  }

  say('npm', 'Atualizando dependências…');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installed = await run(npmCmd, ['install'], { timeout: 10 * 60 * 1000 });
  if (!installed.ok) {
    return {
      ok: false,
      error: 'Atualizei o código, mas falhei ao instalar dependências. Rode "npm install" manualmente. Detalhe: ' + (installed.stderr || installed.error),
    };
  }

  say('done', 'Atualização concluída! Reinicie o app para usar a nova versão.');
  return { ok: true, restartRequired: true };
}

module.exports = {
  checkForUpdates,
  applyUpdate,
  isGitRepo,
  REPO_URL,
};
