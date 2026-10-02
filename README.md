# 📚 CábulIA

> O nerd que faz a sua cola. App de estudos com IA 100% local.


App de desktop que gera **resumos**, **mapas mentais** e **listas de exercícios**, **responde perguntas** sobre o seu material (RAG) e monta um **plano de estudos** a partir de uma pasta de estudos, usando **IA local** (Ollama). Tudo roda na sua máquina — nenhuma informação vai para a nuvem.

## Recursos

- 📁 Acessa **apenas** a pasta que você selecionar
- 📓 Organização em **notebooks** (cada subpasta vira um caderno, estilo OneNote)
- 📄 Lê **qualquer tipo de texto**: `.txt, .md, .pdf, .docx, .html, .csv, .json, .srt`, código-fonte e muitos outros
- 🧾 Abas separadas para **Resumo**, **Mapa Mental** e **Exercícios**
- 🎯 **Direcionamento do resumo**: escolha o foco — **geral**, **foco em prova** (prioriza o que mais cai, destaca termos-chave e lista pontos de atenção), **revisão rápida** ou **entender a fundo**
- 🌍 **Idioma do resultado**: gere o conteúdo no mesmo idioma do material (padrão) ou em outro — português (BR/PT), inglês, espanhol, francês, alemão, italiano, japonês ou chinês. Vale para resumo, mapa mental e exercícios
- 🎯 Gera para **um arquivo específico** ou para a **pasta inteira** (a pasta resume cada arquivo e depois sintetiza tudo — cobre todo o material, não só o início)
- 🔄 **Auto-atualização**: detecta arquivos novos/alterados e recarrega sozinho
- 📤 **Exporta** resultados em `.md` ou `.html` para compartilhar com outros PCs
- 🌙 Visual escuro agradável, inspirado no Obsidian

> **Multiplataforma:** funciona em **Windows, macOS e Linux**. O Electron e o
> Ollama rodam nos três sistemas; o app se adapta ao seu SO automaticamente.

## 🚀 Uso rápido (sem terminal)

**Windows** — os atalhos ficam na pasta **`windows/`**. Dê **duplo-clique**:

1. **`windows/INSTALAR.bat`** — checa Node.js e Ollama, instala dependências e baixa o modelo. Rode uma vez.
2. **`windows/ABRIR ESTUDO AI.bat`** — abre o app (e inicia a IA local).
3. **`windows/ATUALIZAR.bat`** — atualiza o app para a versão mais nova do GitHub (precisa de Git).
4. **`windows/GERAR EXECUTAVEL.bat`** — cria o instalador **e** a versão portátil na pasta `dist/`.
5. **`windows/GERAR PORTATIL.bat`** — cria **só** a versão portátil (um `.exe` que não precisa instalar; a forma mais simples de passar para amigos).

**macOS / Linux** — os scripts ficam na pasta **`unix/`**. Pelo terminal, na pasta do projeto:

```bash
bash unix/INSTALAR.sh   # uma vez: checa Node/Ollama, instala deps e baixa o modelo
bash unix/ABRIR.sh      # abre o app (e inicia a IA local)
```

> Os scripts funcionam de dentro das pastas `windows/` e `unix/` — eles sobem
> para a raiz do projeto sozinhos. Não precisa movê-los.

> Em todos os sistemas é preciso ter o **Node.js**. O **Ollama** o app tenta
> instalar sozinho na primeira execução (veja abaixo).

## ✨ Auto-setup na primeira execução

Ao abrir o app pela **primeira vez**, ele mesmo prepara a IA local:

1. Verifica se o **Ollama** está instalado e rodando.
2. Se não estiver, tenta instalá-lo conforme o sistema:
   - **Windows** — baixa e roda o instalador oficial em modo silencioso.
   - **Linux** — usa o script oficial (`curl -fsSL https://ollama.com/install.sh | sh`).
   - **macOS** — instala via **Homebrew** se disponível; senão, orienta a baixar em ollama.com (arrastar para Aplicativos) e clicar em "Tentar de novo".
3. **Baixa o modelo de linguagem** (`qwen2.5:7b`) automaticamente.

É necessário **internet apenas nessa primeira vez**; depois o app funciona offline.

## Pré-requisitos

- **Windows 10/11**, **macOS** ou **Linux** (64-bit) e internet na primeira execução.
- Para **desenvolver/gerar o executável** você também precisa do **Node.js** 18+ (https://nodejs.org).
- O **Ollama** é instalado automaticamente pelo app (no macOS pode exigir Homebrew ou instalação manual).

## Rodar em modo desenvolvimento

```bash
npm install
npm start
```

## Gerar o executável

O `build` detecta o sistema atual. Para escolher explicitamente:

```bash
npm run build         # gera para o sistema atual
npm run build:win     # Windows: instalador (.exe) + portátil
npm run build:mac     # macOS: .dmg + .zip (x64 e Apple Silicon)
npm run build:linux   # Linux: AppImage + .deb
```

Os arquivos ficam na pasta `dist/`.

> Observação: cada SO só consegue gerar o pacote do **seu próprio** sistema de
> forma confiável (ex.: o `.dmg` do macOS precisa ser gerado num Mac). O
> executável **não** inclui o Ollama — cada máquina o instala uma vez (o app
> ajuda com isso). O app é 100% local e não envia nenhum dado.

## 🧠 Escolha do modelo de IA

Na barra lateral há um seletor **"Modelo de IA"**. Ele lista os modelos instalados
no Ollama e a escolha vale para resumos, mapas mentais e exercícios. A seleção
fica salva entre usos.

Em **"Baixar outro modelo"** você instala um modelo novo direto pelo app (com barra
de progresso), sem terminal. Sugestões:

| Modelo | Bom para | Tamanho aprox. |
|--------|----------|----------------|
| `llama3.2:3b` | PCs fracos / sem GPU, respostas rápidas | ~2 GB |
| `qwen2.5:7b` | **Padrão** — ótimo em PT, cabe em GPU de 6 GB | ~4.7 GB |
| `gemma2:9b` | Ótima escrita, GPU de ~6 GB | ~5.4 GB |
| `qwen2.5:14b` | Melhor qualidade, exige GPU de 10 GB+ | ~9 GB |

> Dica: o padrão `qwen2.5:7b` roda bem na maioria das máquinas. Modelos grandes
> (14B) podem **travar** em GPUs de 6 GB (ex.: GTX 1660) ao gerar textos longos —
> se isso acontecer, volte para um modelo de 7B/9B.

## Como usar

1. Abra o app e clique em **Selecionar pasta de estudos**.
2. Escolha na barra lateral um **arquivo** ou marque **Pasta inteira**.
3. (Opcional) Em **Idioma do resultado**, na barra lateral, escolha a língua de saída. O padrão "Igual ao material" mantém o idioma dos seus arquivos.
4. Vá até a aba desejada (**Resumo**, **Mapa Mental** ou **Exercícios**) e clique em gerar. No **Resumo**, use o seletor de **direcionamento** (geral, foco em prova, revisão rápida, entender a fundo) para ajustar o tom.
5. Use **Exportar** para salvar e compartilhar o resultado.

## 🗂️ Organizar por disciplina (IA)

Além dos **notebooks** (que são as subpastas do disco), o app pode montar uma
visão **por disciplina** — ótima para quem jogou tudo numa pasta só ou quer uma
organização que não bate com as pastas.

> **100% virtual — nada muda no disco.** O recurso **não move, não renomeia, não
> copia e não apaga** nenhum arquivo. Ele apenas cria um **mapeamento** (qual
> arquivo pertence a qual disciplina) guardado localmente, junto das suas
> configurações. Seus arquivos continuam exatamente onde estão.

### Como disparar

É uma ação **sob demanda**: na barra lateral há um botão para **organizar por
disciplina**. O comportamento padrão do app não muda — enquanto você não clicar,
a sidebar continua mostrando os notebooks normais. Quando você agrupa, a sidebar
passa a exibir a visão por disciplina, e qualquer disciplina (ou tópico) pode ser
usada como escopo para gerar **Resumo**, **Mapa Mental** ou **Exercícios**.

### Os dois modos

- **Por pasta (sem IA):** usa as **subpastas** da sua pasta de estudos como
  disciplinas. É **instantâneo**, funciona **offline** e não chama a IA — ideal
  para quem já organizou tudo em subpastas por matéria. Arquivos soltos na raiz
  caem em **"Não classificados"**.
- **Por conteúdo (com IA):** deixa a **IA local** ler o nome, a subpasta e um
  trecho de cada arquivo e agrupar por assunto, em **lotes**. É o modo para pastas
  bagunçadas. Precisa do Ollama rodando.

O app **sugere** um modo ao abrir a tela (olhando se a pasta já parece organizada
por matéria), mas a escolha é sua — dá para forçar o outro.

### Separar em tópicos

Há um **toggle "Separar em tópicos"**. Ligado, a IA faz um segundo passo e
subdivide cada disciplina em tópicos (ex.: dentro de "Cálculo I", separar
"Limites", "Derivadas"). Disciplinas com **menos de 3 arquivos** não são
subdivididas, e arquivos que não se encaixam em nenhum tópico ficam soltos no
nível da disciplina. O toggle é independente do modo escolhido.

### Edição manual

A visão por disciplina é sua para ajustar — e, de novo, **só muda o mapeamento**,
nunca o disco. Você pode:

- **Renomear** uma disciplina;
- **Mesclar** duas disciplinas numa só;
- **Mover** um arquivo de uma disciplina para outra;
- **Criar** uma disciplina nova (começa vazia).

### Incremental

Quando você já agrupou uma pasta e volta depois de adicionar/alterar arquivos, o
app classifica **apenas os arquivos novos ou modificados** e os encaixa nas
disciplinas existentes (criando disciplinas novas só quando preciso) — sem
reprocessar o que já estava classificado. Se quiser recomeçar, há a opção
**"Reagrupar do zero"**, que descarta o mapeamento atual e classifica tudo de
novo.

### Fallback "Não classificados"

Existe sempre uma disciplina **"Não classificados"** para o que a IA não soube
rotular. No modo **por conteúdo**, se o Ollama devolver algo inválido (JSON
quebrado) ou falhar em parte da classificação, os arquivos afetados vão para
**"Não classificados"** em vez de quebrar o agrupamento — depois você reclassifica
na mão ou reagrupa. Já se o Ollama estiver **totalmente offline** logo no começo,
o agrupamento por conteúdo é **cancelado** e nada é salvo (o modo **por pasta**,
que não usa IA, continua funcionando offline).

## ❓ Perguntar sobre o acervo (RAG local)

A aba **Perguntar** deixa você fazer **perguntas em linguagem natural** sobre o
seu material e receber uma resposta **fundamentada apenas no conteúdo da pasta**,
com **citação das fontes** (o arquivo e um trecho de onde veio a informação).
Tudo roda localmente, usando os embeddings do Ollama — nenhum dado sai da máquina.

> **Seus arquivos de estudo nunca são tocados.** A indexação **não move, não
> renomeia e não apaga** nada. O índice (os vetores de busca) é gravado só na
> pasta de dados do app, junto das suas configurações. Os arquivos originais
> ficam exatamente onde estão.

### Como usar

1. Na aba **Perguntar**, clique em **Indexar**. O app lê os arquivos da pasta,
   divide o texto em trechos e gera os embeddings via Ollama, mostrando o
   progresso. Ao terminar, o status informa quantos arquivos e trechos foram
   indexados e qual o modelo de embedding usado.
2. (Opcional) Escolha o **escopo** da pergunta: a **pasta inteira** ou uma
   **disciplina** específica (reaproveitando o agrupamento da aba de disciplinas).
3. Digite a pergunta e clique em **Perguntar**. A resposta aparece em Markdown e,
   abaixo, a lista de **fontes citadas** — clique numa fonte para abrir o arquivo
   no sistema.

### Indexação sob demanda e incremental

A indexação é **sob demanda** (nunca automática ao abrir a pasta). Ela é
**incremental**: ao reindexar, só os arquivos **novos ou alterados** são
reprocessados (detectados por data de modificação + tamanho), e os que sumiram do
disco são removidos do índice. Um arquivo que ficou ilegível fica **pendente**
(não some silenciosamente). Há também **Reindexar do zero**, que descarta o índice
e recria tudo.

### Modelo de embedding

A busca usa o modelo **`nomic-embed-text`** (leve, bom em português). Se ele não
estiver instalado, o app oferece um botão para **baixá-lo** (com barra de
progresso), reusando o mesmo fluxo de download dos outros modelos. A **resposta
final** é gerada pelo modelo de IA que você já escolheu na barra lateral.

### Anti-alucinação e fontes

O prompt instrui o modelo a responder **somente** com base nos trechos
recuperados e a dizer claramente quando a resposta **não está** no material. As
fontes exibidas são sempre os trechos realmente consultados — inclusive quando a
resposta é "não encontrei isso no material".

## 🏷️ Classificar materiais por tipo (IA)

Além de organizar por disciplina, o app pode marcar **que tipo** é cada arquivo:
**aula**, **lista**, **prova**, **trabalho** ou **outro**. Isso alimenta o
**Plano de estudos** (abaixo) e ajuda a saber, de relance, o que é cada material.

> **100% virtual — nada muda no disco.** Assim como o agrupamento por disciplina,
> a classificação **não move, não renomeia e não apaga** nada. Ela guarda só um
> **mapeamento** (qual arquivo é de qual tipo) na pasta de dados do app, junto das
> suas configurações. Os arquivos originais ficam exatamente onde estão.

### Como disparar

Na barra lateral há o botão **"🏷️ Classificar materiais (IA)"**. É uma ação
**sob demanda** (nunca automática): o app primeiro tenta uma **heurística barata**
(pelo nome do arquivo, extensão e pistas do conteúdo) e só escala para a **IA
local** nos casos ambíguos, em **lotes**, com progresso e cancelamento.

### Correção manual

Se a detecção errar, você pode **forçar o tipo** de um arquivo na mão. A correção
manual **persiste** e tem **prioridade** sobre a detecção automática — numa
reclassificação futura ela não é sobrescrita.

### Incremental

A classificação é **incremental**: ao reclassificar depois de adicionar ou alterar
arquivos, só os **novos ou modificados** são reprocessados (detectados por data de
modificação + tamanho). O que já estava classificado — e principalmente as suas
correções manuais — é preservado.

## 📅 Plano de estudos (modo prova)

A aba **Plano** monta um **guia de estudo por disciplina**, priorizando **o que
mais cai**. Ele cruza a **classificação por tipo** (acima) com o conteúdo do seu
material, dando mais peso ao que costuma valer mais nota.

### Como funciona a priorização

Cada assunto recebe um **escore** = soma dos **pesos por tipo** de material ×
um **fator de recência** (materiais mais recentes pesam um pouco mais). Em geral
**provas e listas pesam mais** que trabalhos e aulas na hora de priorizar — a
ideia é destacar o que historicamente mais aparece em avaliação. O resultado é um
texto em Markdown, **fundamentado apenas no seu material** (anti-alucinação), com
indicação da origem da priorização.

### Como usar

1. Classifique os materiais primeiro (seção **"Classificar materiais por tipo"**
   acima) — o plano usa esses tipos para priorizar.
2. Vá até a aba **Plano**, escolha uma **disciplina** no seletor e clique em
   **"Gerar plano"**.
3. O guia aparece priorizando os assuntos que mais tendem a cair.

> Como o Plano se apoia na classificação e no agrupamento por disciplina, ele
> aproveita as Fases anteriores (disciplinas e tipos) sem reprocessar nada no
> disco.

## 🔄 Atualizar o app

O app verifica sozinho se há uma versão mais nova no GitHub e avisa dentro da
própria interface (um aviso aparece no topo quando há atualização).

**Pela interface:** quando o aviso surgir, clique em **"Atualizar agora"**. O app
busca as novidades, aplica (`git pull`) e reinstala as dependências. Ao terminar,
ele **reinicia sozinho** (com uma contagem de 5s) para carregar a nova versão —
você também pode clicar em **"Reiniciar agora"** ou **"Reiniciar depois"**.

**Sem abrir o app** — dê **duplo-clique** no atualizador:

- **Windows:** `windows/ATUALIZAR.bat`
- **macOS / Linux:** `bash unix/ATUALIZAR.sh`

Ele compara sua cópia com o GitHub e, se houver novidade, atualiza o código. As
dependências só são reinstaladas (`npm install`) quando o `package-lock.json`
muda — se nada mudou, ele pula essa etapa e termina mais rápido. Se já estiver na
última versão, apenas avisa.

> **Requisitos:** a atualização automática funciona na versão instalada **via Git**
> (a pasta tem `.git`) e com o **Git** instalado (https://git-scm.com). Se você usa
> o `.exe` empacotado (sem `.git`), o app apenas **notifica** e abre a página do
> projeto para você baixar a versão nova. Alterações locais não salvas são guardadas
> automaticamente (`git stash`) antes de atualizar, para não serem perdidas.

## ⚠️ Aviso de segurança na primeira execução (normal)

Como o app é gratuito e **não tem assinatura digital paga**, o sistema pode
exibir um aviso na **primeira vez**. Isso é esperado e não significa vírus — o
app é 100% local e de código aberto. Como liberar:

- **Windows (SmartScreen):** aparece "O Windows protegeu o seu computador".
  Clique em **"Mais informações"** e depois em **"Executar assim mesmo"**.
  O Windows lembra da escolha; nas próximas vezes abre direto.
- **Windows (Controle de Aplicativo Inteligente / Smart App Control):** no
  Windows 11 recente pode aparecer "O Controle de Aplicativo Inteligente
  bloqueou um arquivo que pode não ser seguro", **sem** a opção "Executar assim
  mesmo". Esse recurso é mais rígido e bloqueia executáveis sem assinatura paga.
  Para liberar:
  1. **Remova a "marca da Internet"** do arquivo baixado: clique com o botão
     direito no `.exe` → **Propriedades** → marque **"Desbloquear"** → **OK**.
  2. Se ainda bloquear, ajuste o recurso em **Configurações → Privacidade e
     segurança → Segurança do Windows → Controle de aplicativo e navegador →
     Controle de aplicativo inteligente**. Se estiver em **"Avaliação"**, ele se
     desliga sozinho quando atrapalha; se estiver **"Ativado"**, desligá-lo é
     **permanente** (só volta reinstalando o Windows) — avalie com cuidado.
  3. Alternativa sem gerar `.exe`: rode o app pelo código com `ABRIR ESTUDO AI.bat`
     (usa `npm start`), que normalmente não é barrado.
- **Windows (antivírus):** se o antivírus remover o arquivo, adicione uma
  **exceção** para a pasta do app e baixe/execute de novo.
- **macOS:** se disser "não é possível abrir (desenvolvedor não identificado)",
  vá em **Ajustes do Sistema → Privacidade e Segurança** e clique em **"Abrir
  mesmo assim"**. Ou clique com o botão direito no app → **Abrir**.
- **Linux (AppImage):** dê permissão de execução:
  `chmod +x "CábulIA-1.0.0.AppImage"` e então execute-o.

> Por que não assinamos: certificados de assinatura de código são pagos
> (anuais) e voltados para distribuição comercial. Para uso doméstico não
> compensa — o "executar assim mesmo" resolve sem custo.

## 🧪 Agente de teste (testar todos os modelos)

Há um agente que testa a IA do app contra **todos os modelos instalados** no
Ollama, usando a pasta `tests/pasta-teste`, e gera um relatório de bugs.

```bash
npm run test:models              # testa todos os modelos instalados
node tests/testar-modelos.js qwen2.5:7b   # testa só um modelo
```

Para cada modelo ele roda: resumo (curto/médio/detalhado), mapa mental e
exercícios de um arquivo, além de resumo e mapa da **pasta inteira** (map-reduce).
O catálogo também cruza **nível × foco** do resumo com IA real (ex.: médio+prova,
detalhado+aprofundado), de forma **incremental** (só reexecuta funções novas por
modelo). Mede o tempo, detecta travamentos/timeout, JSON de mapa inválido e
respostas vazias/rasas, e salva tudo em **`tests/relatorio-testes.md`**.

Quando o **Ollama não está disponível** (serviço parado ou nenhum modelo
instalado), o `npm run test:models` **pula de forma limpa, saindo com código 0**
em vez de falhar.

- Um teste que **trava** além do limite (padrão 150s) é **cancelado de verdade**
  (aborta a geração no Ollama) e marcado como travado. Ao primeiro travamento de
  um modelo, os testes restantes dele são pulados — ele é pesado demais para esta
  máquina. Ajuste o limite com `TESTE_TIMEOUT_S=120`.
- O agente grava incrementalmente em **`tests/bugs.json`** (a cada teste), útil
  para acompanhar em tempo real ou para uma ferramenta/pessoa reagir aos bugs.
- Requer o Ollama rodando com pelo menos um modelo instalado.

## 🧪 Agente de beta testing (bugs funcionais)

Um agente que **exercita de verdade** a lógica do app (sem precisar do Ollama nem
abrir a janela) e procura bugs funcionais. Ele simula as respostas da IA com um
"stub" de `fetch`, então roda rápido e offline.

```bash
npm run test:beta       # roda a bateria offline (inclui a matriz nível × foco)
npm run test:beta2      # reexecuta e cruza os resultados para confirmar determinismo
```

O que ele verifica:
- **Leitura de arquivos** (`library`): varredura da pasta, leitura de texto,
  arquivo inexistente, remoção de tags HTML.
- **Matriz do resumo** (`IA / Matriz Resumo`): cruza **nível × foco** de forma
  determinística, afirmando que a instrução do nível certo entra no prompt, que
  as âncoras de outros níveis **não vazam** e que o foco injeta (ou omite) o
  direcionamento esperado. O `test:beta2` reexecuta a bateria e cruza os
  resultados para garantir que a matriz é estável.
- **Exportação** (`exporter`): markdown/HTML dos três tipos, sanitização do nome
  do arquivo, escape de HTML (sem injeção), payload vazio.
- **Persistência** (`store`): config e cache gravam/leem corretamente.
- **IA** (`ai`): o **idioma** e o **foco** escolhidos entram mesmo no prompt;
  o mapa mental normaliza/valida o JSON; os exercícios respeitam quantidade/idioma.
- **Atualização** (`updater`): detecção de repositório git e formato do retorno.
- **Integração interface↔serviços**: todo `#id` usado no `renderer.js` existe no
  HTML, toda `window.api.*` existe no `preload.js`, todo canal do `preload` tem
  `ipcMain.handle` no `main.js`, e as opções de foco do HTML existem no `ai.js`.

Ele grava dois arquivos (ignorados pelo git):
- **`tests/relatorio-beta.md`** — relatório legível, com severidade (🔴 alta /
  🟡 média / 🔵 baixa) e sugestão de correção para cada bug.
- **`tests/beta-bugs.json`** — os mesmos dados em formato legível por máquina,
  para o desenvolvedor (ou outro agente) corrigir os bugs encontrados.

Se houver bug de **severidade alta**, o processo sai com código ≠ 0 (útil para um
hook ou CI barrar a entrega).

## 🎨 Agente de frontend (bugs visuais e melhorias)

Analisa a interface (`src/renderer`) e gera um relatório de melhorias visuais em
**`tests/relatorio-frontend.md`**.

```bash
npm run test:frontend
```

O que ele verifica:
- **Contraste** de texto (aproximação WCAG AA 4.5:1).
- **Acessibilidade**: foco visível por teclado, `prefers-reduced-motion`,
  rótulos (`aria-label`) em selects, semântica de abas.
- **Responsividade / layout**: larguras/alturas fixas que quebram em janelas
  pequenas.
- **Consistência de tema**: cores fora das variáveis do `:root`.

Ele também **se comunica com o agente de teste**: lê o `tests/bugs.json` e
correlaciona problemas de dados que viram bugs visuais (ex.: mapa mental sem
descrições vira só rótulos, resposta vazia deixa o painel em branco, travamentos
que deixariam um spinner infinito).

> Um agente de linha de comando não "enxerga" a tela; a análise é por regras
> sobre o código + correlação com os testes. Validação visual por pixels exigiria
> abrir a UI num navegador headless.

## 🖼️ Validação visual (Playwright)

Além do agente de frontend (estático), há uma validação visual **real** que abre
a interface num navegador headless, renderiza um mapa mental e uma lista de
exercícios de exemplo, tira **screenshots** e verifica no layout renderizado:
sobreposição de cartões no mapa, se o diagrama Mermaid virou imagem, e se o
gabarito está no final.

```bash
npm run test:visual
```

Requer os navegadores do Playwright (uma vez): `npx playwright install chromium`.
As imagens ficam em `tests/screenshots/` e o resultado é anexado ao
`tests/relatorio-frontend.md`.

## 🧑‍💻 Versão de desenvolvimento vs. versão do usuário

- **Desenvolvimento (sua máquina):** o repositório completo, com os agentes de
  teste (`tests/`), scripts e ferramentas. Rode `npm start`, `npm run test:models`,
  `npm run test:frontend`, `npm run test:visual`.
- **Usuário (executável limpo):** o build **não inclui** `tests/` nem `scripts/`
  (veja `files` no `package.json`) — o usuário recebe só o app.

### Distribuir para outras pessoas (uso pessoal / amigos)

Para passar o app a poucas pessoas próximas, a **versão portátil** é a mais simples:
um único `.exe` que não precisa instalar.

1. Gere o portátil com **`windows/GERAR PORTATIL.bat`** (ou `npm run build:portable`).
   O arquivo `CábulIA <versão>.exe` fica na pasta `dist/`.
2. Envie esse `.exe` para a pessoa (pen drive, nuvem, etc.).
3. Na primeira execução, o Windows pode avisar que o app não é assinado — veja
   **"Aviso de segurança na primeira execução"** acima para liberar (incluindo o
   caso do **Controle de Aplicativo Inteligente** no Windows 11).

> **Sobre a atualização:** quem usa o `.exe` portátil (sem a pasta `.git`) recebe
> apenas o **aviso** de que há versão nova e um atalho para o GitHub — o `git pull`
> automático só funciona na cópia instalada via Git. Para distribuir uma versão
> nova do portátil, gere o `.exe` de novo e reenvie (ou publique no GitHub Releases).
> Quem usa a versão via Git atualiza sozinho pelo botão **"Atualizar agora"** no app.

## Privacidade

- O app lê somente a pasta selecionada.
- Os textos são processados pela IA **local** (Ollama), no seu computador.
- Configurações e um cache de resultados ficam salvos localmente na pasta de
  dados do usuário. Nada é enviado para servidores externos.
