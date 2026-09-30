'use strict';

/**
 * Monitora a pasta de estudos e avisa o app quando algo muda
 * (arquivo criado, editado ou removido), para atualizar a biblioteca
 * automaticamente. Usa um "debounce" para não disparar dezenas de vezes
 * quando muitos arquivos mudam de uma vez.
 */

const chokidar = require('chokidar');

let current = null;
let debounceTimer = null;

function start(folder, onChange) {
  stop();

  current = chokidar.watch(folder, {
    ignored: /(^|[\/\\])(\.|node_modules|\.git)/,
    ignoreInitial: true,
    depth: 20,
    awaitWriteFinish: {
      stabilityThreshold: 600,
      pollInterval: 100,
    },
  });

  const trigger = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onChange && onChange(), 700);
  };

  current
    .on('add', trigger)
    .on('change', trigger)
    .on('unlink', trigger)
    .on('addDir', trigger)
    .on('unlinkDir', trigger);
}

function stop() {
  if (current) {
    current.close();
    current = null;
  }
  clearTimeout(debounceTimer);
}

module.exports = { start, stop };
