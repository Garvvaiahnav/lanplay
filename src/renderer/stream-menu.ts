// In-stream menu page. Classic script (CSP: no inline script, no modules). Wrapped so it adds no globals.
(() => {
  const api = (window as unknown as { lanplayMenu?: { choose(action: string): void } }).lanplayMenu;
  const send = (action: string) => api?.choose(action);
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-action]'))) {
    b.addEventListener('click', () => send(b.dataset['action'] ?? 'dismiss'));
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') send('dismiss');
  });
  // The safe default: a stray Enter keeps the stream running.
  document.getElementById('keep')?.focus();
})();
