'use strict';

/**
 * Auto-atualização do app do usuário via electron-updater.
 *
 * Como funciona:
 *  - Só roda quando o app está EMPACOTADO (instalado), nunca em desenvolvimento.
 *  - Verifica se há uma nova versão publicada e, se houver, baixa em segundo
 *    plano e instala ao fechar (ou avisa o usuário).
 *
 * REQUISITO para funcionar de verdade: as versões precisam ser PUBLICADAS em
 * algum lugar que o electron-updater saiba ler (o mais fácil e grátis é
 * GitHub Releases). Isso é configurado no bloco "publish" do package.json.
 * Sem isso, a verificação simplesmente não encontra atualização (não quebra).
 */

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  // electron-updater não instalado: recurso desativado silenciosamente.
}

function init(app, getWindow, log = console) {
  // Nunca em dev (não há pacote para atualizar).
  if (!app.isPackaged || !autoUpdater) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const notify = (msg, severity = 'info') => {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:status', { msg, severity });
    }
  };

  autoUpdater.on('update-available', (info) => {
    notify(`Atualização ${info && info.version ? info.version : ''} disponível. Baixando…`);
  });
  autoUpdater.on('download-progress', (p) => {
    notify(`Baixando atualização: ${Math.round(p.percent)}%`);
  });
  autoUpdater.on('update-downloaded', () => {
    notify('Atualização pronta. Será instalada ao fechar o app.', 'success');
  });
  autoUpdater.on('error', (err) => {
    log.warn && log.warn('[updater]', err && err.message);
  });

  // Verifica na inicialização e depois a cada 6 horas.
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

module.exports = { init };
