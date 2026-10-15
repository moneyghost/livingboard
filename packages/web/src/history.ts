/**
 * Undo/redo through Excalidraw's own actions (its history already ignores
 * remote and AI changes). We press its internal buttons, present in the DOM
 * even when hidden, and fall back to the keyboard shortcut.
 */
function press(container: string, labels: string[]): boolean {
  // Desktop layout wraps them in a container; the compact layout only has labelled buttons.
  const btn =
    document.querySelector<HTMLButtonElement>(`.excalidraw .${container} button`) ??
    labels.map((l) => document.querySelector<HTMLButtonElement>(`.excalidraw button[aria-label="${l}"]`)).find(Boolean);
  if (!btn) return false;
  btn.click();
  return true;
}

function shortcut(redo: boolean) {
  const target = document.querySelector(".excalidraw") ?? document;
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: redo ? "Z" : "z", code: "KeyZ", ctrlKey: true, metaKey: true, shiftKey: redo, bubbles: true }),
  );
}

export function undo() {
  if (!press("undo-button-container", ["Annulla", "Undo"])) shortcut(false);
}

export function redo() {
  if (!press("redo-button-container", ["Ripeti", "Redo"])) shortcut(true);
}
