/**
 * Data project berubah: register temuan, cakupan, kesimpulan, log kurasi, kotak masuk memori,
 * atau status kurator. Klien yang membuka laporan project/tugas memuat ulang lewat WebSocket —
 * pengganti polling. Polanya sama dengan `onTasksChanged` di tasks.ts.
 */
type Listener = (projectId: string) => void;

const listeners = new Set<Listener>();

export function onProjectChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyProject(projectId: string): void {
  for (const listener of listeners) {
    try {
      listener(projectId);
    } catch {
      // satu penyimak yang error tidak boleh menggagalkan penulisan
    }
  }
}
