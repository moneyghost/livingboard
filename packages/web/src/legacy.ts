/**
 * Before the rename to Livingboard this device kept its settings (name, ink,
 * lens, read messages...) under `sinapsi:` keys: carry them over once.
 * Imported first in main.tsx, before anything reads them.
 */
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith("sinapsi:")) continue;
    const next = `livingboard:${key.slice("sinapsi:".length)}`;
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key) ?? "");
    localStorage.removeItem(key);
  }
} catch {
  // storage blocked (private mode): nothing to carry over
}

export {};
