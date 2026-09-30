# 📚 Estudo AI

App de desktop que gera **resumos**, **mapas mentais** e **listas de exercícios** a partir de uma pasta de estudos, usando **IA local** (Ollama). Tudo roda na sua máquina — nenhuma informação vai para a nuvem.

## Recursos

- 📁 Acessa **apenas** a pasta que você selecionar
- 📓 Organização em **notebooks** (cada subpasta vira um caderno, estilo OneNote)
- 📄 Lê **qualquer tipo de texto**: `.txt, .md, .pdf, .docx, .html, .csv, .json, .srt`, código-fonte e muitos outros
- 🧾 Abas separadas para **Resumo**, **Mapa Mental** e **Exercícios**
- 🎯 Gera para **um arquivo específico** ou para a **pasta inteira** (a pasta resume cada arquivo e depois sintetiza tudo — cobre todo o material, não só o início)
- 🔄 **Auto-atualização**: detecta arquivos novos/alterados e recarrega sozinho
- 📤 **Exporta** resultados em `.md` ou `.html` para compartilhar com outros PCs
- 🌙 Visual escuro agradável, inspirado no Obsidian

> **Multiplataforma:** funciona em **Windows, macOS e Linux**. O Electron e o
> Ollama rodam nos três sistemas; o app se adapta ao seu SO automaticamente.

## 🚀 Uso rápido (sem terminal)

**Windows** — dê **duplo-clique** nos arquivos `.bat`:

1. **`INSTALAR.bat`** — checa Node.js e Ollama, instala dependências e baixa o modelo. Rode uma vez.
2. **`ABRIR ESTUDO AI.bat`** — abre o app (e inicia a IA local).
3. **`GERAR EXECUTAVEL.bat`** — cria o `.exe` na pasta `dist/`.

**macOS / Linux** — pelo terminal, na pasta do projeto:

```bash
bash INSTALAR.sh   # uma vez: checa Node/Ollama, instala deps e baixa o modelo
bash ABRIR.sh      # abre o app (e inicia a IA local)
```

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
3. Vá até a aba desejada (**Resumo**, **Mapa Mental** ou **Exercícios**) e clique em gerar.
4. Use **Exportar** para salvar e compartilhar o resultado.

## ⚠️ Aviso de segurança na primeira execução (normal)

Como o app é gratuito e **não tem assinatura digital paga**, o sistema pode
exibir um aviso na **primeira vez**. Isso é esperado e não significa vírus — o
app é 100% local e de código aberto. Como liberar:

- **Windows (SmartScreen):** aparece "O Windows protegeu o seu computador".
  Clique em **"Mais informações"** e depois em **"Executar assim mesmo"**.
  O Windows lembra da escolha; nas próximas vezes abre direto.
- **Windows (antivírus):** se o antivírus remover o arquivo, adicione uma
  **exceção** para a pasta do app e baixe/execute de novo.
- **macOS:** se disser "não é possível abrir (desenvolvedor não identificado)",
  vá em **Ajustes do Sistema → Privacidade e Segurança** e clique em **"Abrir
  mesmo assim"**. Ou clique com o botão direito no app → **Abrir**.
- **Linux (AppImage):** dê permissão de execução:
  `chmod +x "Estudo AI-1.0.0.AppImage"` e então execute-o.

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
Mede o tempo, detecta travamentos/timeout, JSON de mapa inválido e respostas
vazias/rasas, e salva tudo em **`tests/relatorio-testes.md`**.

- Um teste que **trava** além do limite (padrão 150s) é **cancelado de verdade**
  (aborta a geração no Ollama) e marcado como travado. Ao primeiro travamento de
  um modelo, os testes restantes dele são pulados — ele é pesado demais para esta
  máquina. Ajuste o limite com `TESTE_TIMEOUT_S=120`.
- O agente grava incrementalmente em **`tests/bugs.json`** (a cada teste), útil
  para acompanhar em tempo real ou para uma ferramenta/pessoa reagir aos bugs.
- Requer o Ollama rodando com pelo menos um modelo instalado.

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

### Auto-atualização do app do usuário

O app usa `electron-updater`. Para funcionar, publique cada versão em um
**GitHub Releases** (ou outro provedor). Passos:

1. O `package.json` já aponta para `EnzoMarquesBotelho/estudo-ai` em `build.publish`.
2. Suba o código para um repositório GitHub chamado `estudo-ai` (na conta EnzoMarquesBotelho).
3. Gere e publique com o token do GitHub:
   ```bash
   set GH_TOKEN=seu_token   # (Windows)  |  export GH_TOKEN=... (mac/linux)
   npx electron-builder --win --publish always
   ```
4. Cada vez que você aumentar a `version` no `package.json` e publicar, os apps
   instalados **baixam e aplicam a atualização automaticamente** (aviso na tela).

> Sem publicar, o app funciona normalmente — só não recebe atualizações
> automáticas (a verificação apenas não encontra nada e é ignorada).

## Privacidade

- O app lê somente a pasta selecionada.
- Os textos são processados pela IA **local** (Ollama), no seu computador.
- Configurações e um cache de resultados ficam salvos localmente na pasta de
  dados do usuário. Nada é enviado para servidores externos.
