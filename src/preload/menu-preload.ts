// Sandboxed preload for the in-stream menu window only: one fire-and-forget call, nothing else.
// The main process ignores anything that is not one of the known menu actions (src/core/client/stream-menu.ts).
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('lanplayMenu', {
  choose(action: string): void {
    ipcRenderer.send('stream-menu:choose', String(action));
  },
});
