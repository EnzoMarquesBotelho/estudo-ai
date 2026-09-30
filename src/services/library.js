'use strict';

/**
 * Leitura da pasta de estudos e extração de texto de qualquer formato comum.
 *
 * Modelo de organização (estilo OneNote):
 *   Pasta raiz selecionada
 *   ├── Notebook A/           <- cada subpasta de 1º nível é um "notebook"
 *   │   ├── aula1.pdf
 *   │   └── resumo.md
 *   ├── Notebook B/
 *   └── solto.txt             <- arquivos na raiz vão para o notebook "Geral"
 */

const fs = require('fs');
const path = require('path');

// Extensões tratadas como texto puro (lista ampla — "todo tipo de texto").
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.rtf', '.csv', '.tsv', '.log',
  '.json', '.xml', '.yaml', '.yml', '.html', '.htm',
  '.js', '.ts', '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rb',
  '.php', '.sql', '.sh', '.tex', '.srt', '.vtt', '.ini', '.conf',
]);
const PDF_EXT = new Set(['.pdf']);
const DOCX_EXT = new Set(['.docx']);

const IGNORE_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '__MACOSX']);

function isSupported(file) {
  const ext = path.extname(file).toLowerCase();
  return TEXT_EXT.has(ext) || PDF_EXT.has(ext) || DOCX_EXT.has(ext);
}

/**
 * Varre a pasta e devolve a estrutura de notebooks e arquivos.
 * Não lê o conteúdo aqui (só metadados) para ser rápido.
 */
function scan(root) {
  const notebooks = [];

  const rootFiles = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { root, notebooks: [] };
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const nbPath = path.join(root, entry.name);
      const files = collectFiles(nbPath);
      if (files.length) {
        notebooks.push({ name: entry.name, path: nbPath, files });
      }
    } else if (entry.isFile() && isSupported(entry.name)) {
      const p = path.join(root, entry.name);
      rootFiles.push(fileMeta(p));
    }
  }

  if (rootFiles.length) {
    notebooks.unshift({ name: 'Geral', path: root, files: rootFiles });
  }

  return { root, notebooks };
}

// Lista recursivamente os arquivos suportados de um notebook.
function collectFiles(dir) {
  const out = [];
  const walk = (d) => {
    let items = [];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        if (IGNORE_DIRS.has(it.name) || it.name.startsWith('.')) continue;
        walk(path.join(d, it.name));
      } else if (it.isFile() && isSupported(it.name)) {
        out.push(fileMeta(path.join(d, it.name)));
      }
    }
  };
  walk(dir);
  return out;
}

function fileMeta(p) {
  let size = 0, mtime = 0;
  try {
    const st = fs.statSync(p);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {}
  return {
    name: path.basename(p),
    path: p,
    ext: path.extname(p).toLowerCase(),
    size,
    mtime,
  };
}

/**
 * Extrai o texto de um arquivo, escolhendo o parser pela extensão.
 * PDF e DOCX usam libs; o resto é lido como texto.
 */
async function readFileText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (PDF_EXT.has(ext)) {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      return { ok: true, text: cleanup(data.text), name: path.basename(filePath) };
    }
    if (DOCX_EXT.has(ext)) {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ path: filePath });
      return { ok: true, text: cleanup(value), name: path.basename(filePath) };
    }
    // Texto puro (inclui .md, .html, código, etc.)
    let text = fs.readFileSync(filePath, 'utf-8');
    if (ext === '.html' || ext === '.htm') text = stripHtml(text);
    return { ok: true, text: cleanup(text), name: path.basename(filePath) };
  } catch (e) {
    return { ok: false, error: e.message, name: path.basename(filePath) };
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ');
}

function cleanup(t) {
  return (t || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { scan, readFileText, isSupported };
