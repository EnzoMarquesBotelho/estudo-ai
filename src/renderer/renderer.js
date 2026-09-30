'use strict';

// Estado da aplicação (só na interface).
const state = {
  root: null,
  notebooks: [],
  selectedFile: null,   // { name, path }
  scope: 'file',        // 'file' | 'all'
  lastResults: {},      // cache em memória: summary/mindmap/exercises
  model: null,          // modelo de IA escolhido pelo usuário
};

// ------------------------------ Helpers ------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = 'toast'), 3500);
}

function spinner(container, label = 'Gerando…') {
  container.innerHTML = `<div class="spinner"></div><div class="placeholder">${label}<br><small>Isso pode levar alguns segundos com a IA local.</small></div>`;
}

function placeholder(container, msg) {
  container.innerHTML = `<div class="placeholder">${msg}</div>`;
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Mini renderizador de Markdown (headers, listas, negrito, código + Mermaid).
// Blocos ```mermaid viram diagramas; outros blocos ``` viram <pre>.
let __mmSeq = 0;
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linhas = (md || '').split('\n');
  let html = '', inUl = false, inOl = false;
  let emBloco = false, blocoLang = '', blocoConteudo = [];
  const closeLists = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
  };

  for (let raw of linhas) {
    const fence = raw.match(/^```\s*(\w+)?/);
    if (fence) {
      if (!emBloco) { emBloco = true; blocoLang = (fence[1] || '').toLowerCase(); blocoConteudo = []; closeLists(); }
      else {
        // Fecha o bloco.
        const conteudo = blocoConteudo.join('\n');
        if (blocoLang === 'mermaid') {
          // Marcado para o mermaid renderizar depois (guardamos o código cru).
          const id = 'mm-diagram-' + (__mmSeq++);
          html += `<div class="mermaid-diagram" data-id="${id}"><pre class="mermaid">${esc(conteudo)}</pre></div>`;
        } else {
          html += `<pre class="code-block">${esc(conteudo)}</pre>`;
        }
        emBloco = false; blocoLang = ''; blocoConteudo = [];
      }
      continue;
    }
    if (emBloco) { blocoConteudo.push(raw); continue; }

    let line = esc(raw);
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
               .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (/^### /.test(line)) { closeLists(); html += `<h3>${line.slice(4)}</h3>`; }
    else if (/^## /.test(line)) { closeLists(); html += `<h2>${line.slice(3)}</h2>`; }
    else if (/^# /.test(line)) { closeLists(); html += `<h1>${line.slice(2)}</h1>`; }
    else if (/^\s*[-*] /.test(line)) {
      if (!inUl) { closeLists(); html += '<ul>'; inUl = true; }
      html += `<li>${line.replace(/^\s*[-*] /, '')}</li>`;
    } else if (/^\s*\d+\. /.test(line)) {
      if (!inOl) { closeLists(); html += '<ol>'; inOl = true; }
      html += `<li>${line.replace(/^\s*\d+\. /, '')}</li>`;
    } else if (line.trim() === '') { closeLists(); }
    else { closeLists(); html += `<p>${line}</p>`; }
  }
  // Bloco não fechado (resposta cortada): mostra o que veio.
  if (emBloco && blocoConteudo.length) {
    html += `<pre class="code-block">${esc(blocoConteudo.join('\n'))}</pre>`;
  }
  closeLists();
  return html;
}

// Renderiza os diagramas Mermaid presentes em um container (depois do innerHTML).
function renderizarMermaid(container) {
  if (typeof window.mermaid === 'undefined') return; // lib ausente: fica o texto
  try {
    if (!renderizarMermaid._init) {
      window.mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
      renderizarMermaid._init = true;
    }
    const blocos = container.querySelectorAll('pre.mermaid');
    blocos.forEach(async (pre, i) => {
      const code = pre.textContent;
      try {
        const { svg } = await window.mermaid.render('mmr-' + Date.now() + '-' + i, code);
        const wrap = document.createElement('div');
        wrap.className = 'mermaid-rendered';
        wrap.innerHTML = svg;
        pre.replaceWith(wrap);
      } catch {
        // Se o diagrama for inválido, mantém o texto do código (não quebra a tela).
      }
    });
  } catch {}
}

// ------------------------------ Biblioteca ------------------------------
async function loadLibrary(folder) {
  const lib = await window.api.scanLibrary(folder);
  state.root = lib.root || folder;
  state.notebooks = lib.notebooks || [];
  renderNotebooks();
  if (state.root) {
    $('#folderPath').textContent = state.root;
    $('#folderPath').title = state.root;
    window.api.startWatch(state.root);
  }
}

function renderNotebooks() {
  const wrap = $('#notebooks');
  wrap.innerHTML = '';
  if (!state.notebooks.length) {
    placeholder(wrap, 'Nenhum arquivo de texto encontrado nesta pasta.');
    return;
  }
  for (const nb of state.notebooks) {
    const el = document.createElement('div');
    el.className = 'notebook open';
    const files = nb.files.map((f) =>
      `<div class="file-item" data-path="${encodeURIComponent(f.path)}" data-name="${encodeURIComponent(f.name)}" title="${f.name}">${f.name}</div>`
    ).join('');
    el.innerHTML = `
      <div class="notebook-header">
        <span>📓 ${nb.name}</span>
        <span class="count">${nb.files.length}</span>
      </div>
      <div class="notebook-files">${files}</div>`;
    el.querySelector('.notebook-header').addEventListener('click', () => el.classList.toggle('open'));
    wrap.appendChild(el);
  }

  $$('.file-item').forEach((item) => {
    item.addEventListener('click', () => {
      $$('.file-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
      state.selectedFile = {
        path: decodeURIComponent(item.dataset.path),
        name: decodeURIComponent(item.dataset.name),
      };
      updateTitle();
    });
  });
}

function updateTitle() {
  const t = $('#currentTitle');
  if (state.scope === 'all') {
    t.textContent = `Pasta inteira (${state.notebooks.reduce((s, n) => s + n.files.length, 0)} arquivos)`;
  } else if (state.selectedFile) {
    t.textContent = state.selectedFile.name;
  } else {
    t.textContent = 'Nenhum arquivo selecionado';
  }
}

// Lê o texto de UM arquivo (escopo "arquivo selecionado").
async function gatherText() {
  if (!state.selectedFile) return { ok: false, error: 'Selecione um arquivo primeiro.' };
  const r = await window.api.readFile(state.selectedFile.path);
  if (!r.ok) return { ok: false, error: 'Não consegui ler o arquivo: ' + r.error };
  return { ok: true, text: r.text, title: state.selectedFile.name };
}

// Lê TODOS os arquivos da pasta e devolve um array {name, text, path, mtime, size}.
// Os metadados (path/mtime/size) permitem cachear o resumo parcial de cada
// arquivo e reaproveitá-lo nas próximas gerações (mapa, exercícios).
async function gatherFiles() {
  const allFiles = state.notebooks.flatMap((n) => n.files);
  if (!allFiles.length) return { ok: false, error: 'A pasta não tem arquivos.' };
  const out = [];
  for (const f of allFiles) {
    const r = await window.api.readFile(f.path);
    if (r.ok && r.text && r.text.trim()) {
      out.push({ name: r.name, text: r.text, path: f.path, mtime: f.mtime, size: f.size });
    }
  }
  if (!out.length) return { ok: false, error: 'Nenhum arquivo legível na pasta.' };
  return { ok: true, files: out };
}

// Mostra progresso do map-reduce no container (arquivo X de N).
// Distingue quando está lendo do zero de quando reaproveita o cache (rápido).
function bindFolderProgress(container, label) {
  window.api.onAiProgress((p) => {
    if (p.phase === 'reduce') {
      spinner(container, p.message || 'Combinando resultados…');
    } else if (p.total) {
      const pct = Math.round((p.current / p.total) * 100);
      const acao = p.cached ? '⚡ Reaproveitando' : 'Lendo';
      container.innerHTML =
        `<div class="spinner"></div><div class="placeholder">${label}<br>` +
        `<small>${acao} arquivo ${p.current} de ${p.total}: ${escapeHtml(p.name || '')}</small>` +
        `<div class="setup-progress-bar" style="margin-top:14px"><div class="setup-progress-fill" style="width:${pct}%"></div></div></div>`;
    }
  });
}

// Mostra o texto surgindo em tempo real (streaming) no container.
function bindStreaming(container) {
  window.api.onAiToken((texto) => {
    container.innerHTML = renderMarkdown(texto);
    container.scrollTop = container.scrollHeight;
  });
}

// ------------------------------ IA: ações ------------------------------
async function doSummary() {
  const out = $('#summaryOutput');
  const opts = { nivel: $('#summaryLevel').value, model: state.model };
  let res;
  bindStreaming(out);
  if (state.scope === 'all') {
    const g = await gatherFiles();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Resumindo a pasta inteira');
    bindFolderProgress(out, 'Resumindo a pasta inteira');
    res = await window.api.summaryFolder(g.files, opts);
  } else {
    const g = await gatherText();
    if (!g.ok) return toast(g.error, 'error');
    if (!g.text) return toast('O conteúdo está vazio.', 'error');
    spinner(out, 'Resumindo');
    res = await window.api.summary(g.text, opts);
  }
  if (!res.ok) { placeholder(out, '⚠️ ' + res.error); return toast(res.error, 'error'); }
  out.innerHTML = renderMarkdown(res.text);
  renderizarMermaid(out);
  state.lastResults.summary = { text: res.text };
  toast('Resumo pronto (' + res.model + ')', 'success');
}

async function doMindmap() {
  const out = $('#mindmapOutput');
  const opts = { model: state.model };
  let res;
  if (state.scope === 'all') {
    const g = await gatherFiles();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Montando o mapa da pasta');
    bindFolderProgress(out, 'Montando o mapa da pasta');
    res = await window.api.mindmapFolder(g.files, opts);
  } else {
    const g = await gatherText();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Montando o mapa mental');
    res = await window.api.mindmap(g.text, opts);
  }
  if (!res.ok) { placeholder(out, '⚠️ ' + res.error); return toast(res.error, 'error'); }
  renderMindmap(out, res.map);
  state.lastResults.mindmap = { map: res.map };
  toast('Mapa mental pronto', 'success');
}

async function doExercises() {
  const out = $('#exercisesOutput');
  const opts = {
    quantidade: Number($('#exQtd').value),
    tipo: $('#exTipo').value,
    model: state.model,
  };
  let res;
  bindStreaming(out);
  if (state.scope === 'all') {
    const g = await gatherFiles();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Criando exercícios da pasta');
    bindFolderProgress(out, 'Criando exercícios da pasta');
    res = await window.api.exercisesFolder(g.files, opts);
  } else {
    const g = await gatherText();
    if (!g.ok) return toast(g.error, 'error');
    spinner(out, 'Criando exercícios');
    res = await window.api.exercises(g.text, opts);
  }
  if (!res.ok) { placeholder(out, '⚠️ ' + res.error); return toast(res.error, 'error'); }
  out.innerHTML = renderMarkdown(res.text);
  renderizarMermaid(out);
  state.lastResults.exercises = { text: res.text };
  toast('Exercícios prontos', 'success');
}

// Paleta suave para colorir os ramos (estilo mapa mental).
const MM_COLORS = ['#89b4fa', '#f9e2af', '#a6e3a1', '#f5c2e7', '#fab387', '#94e2d5'];

// Desenha o mapa mental em layout RADIAL: tema central no meio e os ramos
// distribuídos em círculo ao redor, com linhas conectando cada um ao centro.
function renderMindmap(container, map) {
  container.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'mm-stage';
  container.appendChild(stage);

  // Camada SVG para as linhas de conexão (fica atrás dos cartões).
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'mm-links');
  stage.appendChild(svg);

  // Nó central.
  const central = document.createElement('div');
  central.className = 'mm-central';
  central.textContent = map.central;
  stage.appendChild(central);

  const nodes = map.nodes || [];
  const branchEls = [];

  // Cria os cartões dos ramos posicionados em círculo.
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2; // começa no topo
    const color = MM_COLORS[i % MM_COLORS.length];

    const branch = document.createElement('div');
    branch.className = 'mm-node';
    branch.dataset.angle = angle;

    let childrenHtml = '';
    for (const c of node.children || []) {
      const titulo = typeof c === 'string' ? c : (c.titulo || '');
      const descricao = typeof c === 'string' ? '' : (c.descricao || '');
      childrenHtml += `<div class="mm-sub"><span class="mm-sub-title">${escapeHtml(titulo)}</span>${descricao ? `<span class="mm-sub-desc">${escapeHtml(descricao)}</span>` : ''}</div>`;
    }

    branch.innerHTML =
      `<div class="mm-node-title" style="background:${color}">${escapeHtml(node.title)}</div>` +
      `<div class="mm-node-body">${childrenHtml}</div>`;
    stage.appendChild(branch);
    branchEls.push({ el: branch, angle, color });
  });

  // Posiciona os elementos depois que o layout tem tamanho conhecido.
  const layout = () => {
    // O palco é uma tela fixa e grande, maior que a área visível: assim dá para
    // navegar por barras de rolagem E por arraste (pan). O raio cresce com o
    // número de ramos para evitar sobreposição.
    const W = Math.max(container.clientWidth, 900, 260 + nodes.length * 90);
    const H = Math.max(container.clientHeight, 640, 240 + nodes.length * 70);
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';
    const cx = W / 2;
    const cy = H / 2;

    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';

    central.style.left = cx - central.offsetWidth / 2 + 'px';
    central.style.top = cy - central.offsetHeight / 2 + 'px';

    // Raio proporcional ao palco e ao número de ramos.
    const radius = Math.min(W, H) * 0.34 + 40;

    branchEls.forEach(({ el, angle, color }) => {
      const bx = cx + radius * Math.cos(angle);
      const by = cy + radius * Math.sin(angle);
      el.style.left = bx - el.offsetWidth / 2 + 'px';
      el.style.top = by - el.offsetHeight / 2 + 'px';

      const path = document.createElementNS(svgNS, 'path');
      const mx = (cx + bx) / 2;
      path.setAttribute('d', `M ${cx} ${cy} Q ${mx} ${cy} ${bx} ${by}`);
      path.setAttribute('stroke', color);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('opacity', '0.6');
      svg.appendChild(path);
    });

    // Centraliza a visão inicial no nó central.
    container.scrollLeft = (W - container.clientWidth) / 2;
    container.scrollTop = (H - container.clientHeight) / 2;
  };

  requestAnimationFrame(layout);
  if (renderMindmap._resize) window.removeEventListener('resize', renderMindmap._resize);
  renderMindmap._resize = () => layout();
  window.addEventListener('resize', renderMindmap._resize);

  // ---- Navegação por arraste (pan) do mouse ----
  habilitarPan(container, stage);
}

// Permite arrastar com o mouse para navegar (pan), além das barras de rolagem.
function habilitarPan(container, stage) {
  let arrastando = false, startX = 0, startY = 0, scrollX = 0, scrollY = 0, moveu = false;

  const onDown = (e) => {
    // Não inicia arraste ao clicar num cartão clicável (deixa o clique normal).
    if (e.button !== 0) return;
    arrastando = true; moveu = false;
    startX = e.clientX; startY = e.clientY;
    scrollX = container.scrollLeft; scrollY = container.scrollTop;
    container.classList.add('grabbing');
  };
  const onMove = (e) => {
    if (!arrastando) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moveu = true;
    container.scrollLeft = scrollX - dx;
    container.scrollTop = scrollY - dy;
  };
  const onUp = () => { arrastando = false; container.classList.remove('grabbing'); };

  container.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  // Evita que um arraste vire clique acidental num nó.
  container.addEventListener('click', (e) => { if (moveu) { e.stopPropagation(); e.preventDefault(); } }, true);
}

// ------------------------------ Exportar ------------------------------
async function exportKind(kind) {
  const payload = state.lastResults[kind];
  if (!payload) return toast('Gere o conteúdo antes de exportar.', 'error');
  const title = state.scope === 'all' ? 'Pasta inteira' : (state.selectedFile?.name || 'estudo');
  const res = await window.api.exportSave(title, kind, payload);
  if (res && res.ok) toast('Exportado: ' + res.path, 'success');
  else if (res && res.error) toast('Erro ao exportar: ' + res.error, 'error');
}

// ------------------------------ IA: status ------------------------------
async function refreshAiStatus() {
  const el = $('#aiStatus');
  const st = await window.api.aiStatus();
  if (st.ok) {
    el.className = 'ai-status ok';
    el.textContent = `IA local ativa · ${st.models.length} modelo(s)`;
    populateModels(st.models);
  } else {
    el.className = 'ai-status bad';
    el.textContent = 'IA offline — abra o Ollama';
  }
}

// Preenche o dropdown de modelos instalados e mantém a seleção atual.
function populateModels(models) {
  const sel = $('#modelSelect');
  if (!models || !models.length) return;
  const atual = state.model;
  // Só recria se a lista mudou (evita resetar durante uso).
  const existentes = Array.from(sel.options).map((o) => o.value);
  const igual = existentes.length === models.length && existentes.every((v, i) => v === models[i]);
  if (igual) return;

  sel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  // Mantém o salvo se ainda existir; senão usa o primeiro.
  if (atual && models.includes(atual)) sel.value = atual;
  else { state.model = models[0]; window.api.setModel(models[0]); sel.value = models[0]; }
}

// Baixa um novo modelo pela interface, mostrando progresso.
async function pullNewModel() {
  const model = $('#modelToPull').value;
  const wrap = $('#pullProgress');
  const fill = $('#pullFill');
  const msg = $('#pullMsg');
  const btn = $('#pullModelBtn');
  wrap.style.display = 'block';
  btn.disabled = true;
  msg.textContent = 'Iniciando download…';

  window.api.onSetupProgress((p) => {
    if (p.phase === 'model') {
      fill.style.width = (p.percent || 0) + '%';
      msg.textContent = `${p.message || 'Baixando'} ${p.percent || 0}%`;
    }
  });

  const res = await window.api.pullModel(model);
  btn.disabled = false;
  if (res.ok) {
    msg.textContent = 'Modelo baixado!';
    fill.style.width = '100%';
    toast('Modelo ' + model + ' pronto', 'success');
    await refreshAiStatus();
    state.model = model;
    await window.api.setModel(model);
    $('#modelSelect').value = model;
  } else {
    msg.textContent = '⚠️ ' + res.error;
    toast('Erro ao baixar: ' + res.error, 'error');
  }
}

// ------------------------------ Eventos ------------------------------
function bindEvents() {
  $('#pickFolderBtn').addEventListener('click', async () => {
    const folder = await window.api.pickFolder();
    if (folder) { await loadLibrary(folder); toast('Pasta carregada', 'success'); }
  });

  $$('input[name="scope"]').forEach((r) =>
    r.addEventListener('change', (e) => { state.scope = e.target.value; updateTitle(); })
  );

  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      $('#panel-' + tab.dataset.tab).classList.add('active');
    })
  );

  $('#genSummary').addEventListener('click', doSummary);
  $('#genMindmap').addEventListener('click', doMindmap);
  $('#genExercises').addEventListener('click', doExercises);

  $('#exportSummary').addEventListener('click', () => exportKind('summary'));
  $('#exportMindmap').addEventListener('click', () => exportKind('mindmap'));
  $('#exportExercises').addEventListener('click', () => exportKind('exercises'));

  // Troca de modelo
  $('#modelSelect').addEventListener('change', async (e) => {
    state.model = e.target.value;
    await window.api.setModel(state.model);
    toast('Modelo: ' + state.model, 'success');
  });
  $('#pullModelBtn').addEventListener('click', pullNewModel);

  // Auto-atualização quando a pasta muda.
  window.api.onLibraryChanged(async () => {
    await loadLibrary(state.root);
    toast('Biblioteca atualizada automaticamente', 'success');
  });
}

// ------------------------------ Auto-setup ------------------------------
function setupUI() {
  return {
    overlay: $('#setupOverlay'),
    title: $('#setupTitle'),
    message: $('#setupMessage'),
    progressWrap: $('#setupProgressWrap'),
    fill: $('#setupProgressFill'),
    percent: $('#setupPercent'),
    stepOllama: $('#step-ollama'),
    stepModel: $('#step-model'),
    startBtn: $('#setupStartBtn'),
    retryBtn: $('#setupRetryBtn'),
    note: $('#setupNote'),
  };
}

function showProgress(ui, show) {
  ui.progressWrap.style.display = show ? 'block' : 'none';
}
function setProgress(ui, percent) {
  ui.fill.style.width = (percent || 0) + '%';
  ui.percent.textContent = (percent || 0) + '%';
}

// Executa o fluxo completo de preparação. Retorna true se o app está pronto.
async function runSetup() {
  const ui = setupUI();
  ui.overlay.style.display = 'flex';
  ui.startBtn.style.display = 'none';
  ui.retryBtn.style.display = 'none';
  ui.note.className = 'setup-note';

  // Recebe progresso do processo principal.
  window.api.onSetupProgress((p) => {
    ui.message.textContent = p.message || '';
    showProgress(ui, true);
    setProgress(ui, p.percent);
    if (p.phase === 'download' || p.phase === 'install') ui.stepOllama.classList.add('active');
    if (p.phase === 'model') {
      ui.stepOllama.classList.remove('active');
      ui.stepOllama.classList.add('done');
      ui.stepModel.classList.add('active');
    }
  });

  ui.message.textContent = 'Verificando a IA local…';
  let st = await window.api.setupCheck();

  if (st.ready) {
    finishSetup(ui);
    return true;
  }

  // Precisa instalar algo: mostra o botão e espera o usuário confirmar.
  const faltando = [];
  if (!st.ollamaInstalled) faltando.push('a IA local (Ollama)');
  if (!st.hasModel) faltando.push('o modelo de linguagem');
  ui.message.textContent = 'Falta instalar: ' + faltando.join(' e ') + '.';
  ui.startBtn.style.display = 'block';

  return new Promise((resolve) => {
    const doInstall = async () => {
      ui.startBtn.style.display = 'none';
      ui.retryBtn.style.display = 'none';
      ui.note.className = 'setup-note';
      try {
        // 1. Ollama, se necessário.
        st = await window.api.setupCheck();
        if (!st.serverUp) {
          ui.stepOllama.classList.add('active');
          ui.message.textContent = 'Instalando a IA local…';
          const r = await window.api.setupInstallOllama();
          if (!r.ok) throw new Error(r.error);
        }
        ui.stepOllama.classList.remove('active');
        ui.stepOllama.classList.add('done');

        // 2. Modelo, se necessário.
        st = await window.api.setupCheck();
        if (!st.hasModel) {
          ui.stepModel.classList.add('active');
          ui.message.textContent = 'Baixando o modelo (pode demorar)…';
          const r = await window.api.setupPullModel(st.model);
          if (!r.ok) throw new Error(r.error);
        }
        ui.stepModel.classList.remove('active');
        ui.stepModel.classList.add('done');

        // 3. Confirmação final.
        st = await window.api.setupCheck();
        if (!st.ready) throw new Error('A preparação terminou, mas a IA ainda não respondeu. Tente de novo.');
        finishSetup(ui);
        resolve(true);
      } catch (e) {
        ui.message.textContent = '⚠️ ' + e.message;
        ui.note.className = 'setup-note error';
        ui.note.textContent = 'Você pode tentar de novo ou instalar o Ollama manualmente em ollama.com.';
        ui.retryBtn.style.display = 'block';
        showProgress(ui, false);
      }
    };

    ui.startBtn.onclick = doInstall;
    ui.retryBtn.onclick = doInstall;
  });
}

function finishSetup(ui) {
  ui.stepOllama.classList.add('done');
  ui.stepModel.classList.add('done');
  ui.message.textContent = 'Tudo pronto!';
  setProgress(ui, 100);
  setTimeout(() => { ui.overlay.style.display = 'none'; }, 600);
}

// ------------------------------ Init ------------------------------
(async function init() {
  bindEvents();

  // Avisos de auto-atualização (quando empacotado e publicado).
  window.api.onUpdateStatus((d) => toast(d.msg, d.severity || 'info'));

  // Primeiro garante que a IA local está pronta (auto-setup).
  await runSetup();

  // Carrega o modelo salvo antes de listar (para manter a escolha do usuário).
  state.model = await window.api.getModel();

  await refreshAiStatus();
  setInterval(refreshAiStatus, 15000);

  const saved = await window.api.getSavedFolder();
  if (saved) await loadLibrary(saved);

  placeholder($('#summaryOutput'), 'Selecione um arquivo (ou a pasta inteira) e clique em "Gerar resumo".');
  placeholder($('#mindmapOutput'), 'Selecione um arquivo (ou a pasta inteira) e clique em "Gerar mapa mental".');
  placeholder($('#exercisesOutput'), 'Escolha as opções e clique em "Gerar exercícios".');
})();
