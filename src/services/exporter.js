'use strict';

/**
 * Exporta os resultados gerados (resumo, mapa mental, exercícios) para
 * arquivos .md ou .html, que o usuário pode enviar/abrir em outro computador.
 * É o mecanismo de "compartilhamento": arquivos autocontidos e portáteis.
 */

const fs = require('fs');
const path = require('path');

function suggestFilename(title, kind) {
  const safe = (title || 'estudo-ai').replace(/[^\w\-À-ÿ ]+/g, '').trim().slice(0, 60);
  const suffix = { summary: 'resumo', mindmap: 'mapa-mental', exercises: 'exercicios' }[kind] || kind;
  return `${safe} - ${suffix}.md`;
}

function save(filePath, kind, payload) {
  const ext = path.extname(filePath).toLowerCase();
  let content;
  if (ext === '.html') {
    content = toHtml(kind, payload);
  } else {
    content = toMarkdown(kind, payload);
  }
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function toMarkdown(kind, payload) {
  if (kind === 'mindmap' && payload && payload.map) {
    const { central, nodes } = payload.map;
    let md = `# 🧠 Mapa Mental: ${central}\n\n`;
    for (const n of nodes || []) {
      md += `## ${n.title}\n`;
      for (const c of n.children || []) {
        if (typeof c === 'string') {
          md += `- ${c}\n`;
        } else {
          md += `- **${c.titulo || ''}**${c.descricao ? ': ' + c.descricao : ''}\n`;
        }
      }
      md += '\n';
    }
    return md;
  }
  // resumo e exercícios já vêm em markdown
  return (payload && payload.text) || '';
}

function toHtml(kind, payload) {
  const body = escapeHtml(toMarkdown(kind, payload)).replace(/\n/g, '<br>');
  return `<!doctype html>
<html lang="pt-br"><head><meta charset="utf-8">
<title>CábulIA</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222;background:#fafafa}
</style></head>
<body>${body}</body></html>`;
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { save, suggestFilename };
