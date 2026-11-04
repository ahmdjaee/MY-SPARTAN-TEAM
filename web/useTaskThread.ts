import { useCallback, useEffect, useRef, useState } from "react";
import { api, type StoredEvent, type TaskDetail, type WorkerStatus } from "./api.ts";

export type TaskThread = {
  detail?: TaskDetail;
  events: StoredEvent[];
  status: WorkerStatus;
  streaming: string;
  /** Gagal memuat tugas (mis. id tidak ada). Putusnya stream bukan error — lihat `disconnected`. */
  error?: string;
  /** Stream sedang terputus dan browser mencoba menyambung ulang. */
  disconnected: boolean;
  /** Masih ada event lebih lama di server. */
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
};

/** Jendela awal: cukup untuk membaca konteks terakhir tanpa menarik ribuan event T-015. */
const INITIAL_WINDOW = 300;
const OLDER_WINDOW = 300;
/** Token streaming ditampung dan dikeluarkan maksimal 10× per detik, bukan per token. */
const STREAM_FLUSH_MS = 100;

const EPHEMERAL = new Set(["delta", "status"]);

/** Kunci dedupe: permintaan terbuka (seq 0) datang dari snapshot DAN dari stream dengan `ts` berbeda. */
function keyOf(event: StoredEvent): string {
  if (event.seq > 0) return `seq:${event.seq}`;
  if (event.type === "approval") return `approval:${event.approvalId}`;
  if (event.type === "question") return `question:${event.questionId}`;
  const { ts: _ts, ...rest } = event;
  return `${event.type}:${JSON.stringify(rest).slice(0, 120)}`;
}

/**
 * Memuat detail tugas lalu menyimak event-nya lewat SSE.
 *
 * Urutannya: stream dibuka dulu, snapshot diambil saat `onopen` — jadi tidak ada event yang
 * jatuh di antara keduanya. Saat sambungan pulih, browser mengirim Last-Event-ID dan server
 * mengirim ulang yang terlewat; di sini cukup menyegarkan metadata.
 */
export function useTaskThread(taskId: string | undefined, refreshKey: number): TaskThread {
  const [detail, setDetail] = useState<TaskDetail>();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [status, setStatus] = useState<WorkerStatus>("idle");
  const [streaming, setStreaming] = useState("");
  const [error, setError] = useState<string>();
  const [disconnected, setDisconnected] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const seen = useRef(new Set<string>());
  const streamBuffer = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const oldestSeq = useRef<number | undefined>(undefined);

  const merge = useCallback((incoming: StoredEvent[]) => {
    const fresh: StoredEvent[] = [];
    for (const event of incoming) {
      if (EPHEMERAL.has(event.type)) continue;
      const id = keyOf(event);
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      fresh.push(event);
      if (event.seq > 0 && (oldestSeq.current === undefined || event.seq < oldestSeq.current)) {
        oldestSeq.current = event.seq;
      }
    }
    if (fresh.length === 0) return;
    setEvents((previous) => {
      const next = [...previous, ...fresh];
      // Event replay/jendela lama bisa datang setelah event live; seq 0 (permintaan terbuka) tetap di akhir.
      const tail = previous[previous.length - 1]?.seq ?? 0;
      const unordered = fresh.some((event) => event.seq > 0 && event.seq < tail);
      if (unordered) next.sort((a, b) => (a.seq || Infinity) - (b.seq || Infinity));
      return next;
    });
  }, []);

  const clearStream = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
    streamBuffer.current = "";
    setStreaming("");
  }, []);

  useEffect(() => {
    if (!taskId) return;
    let active = true;
    let opened = false;
    seen.current = new Set();
    oldestSeq.current = undefined;
    setDetail(undefined);
    setStatus("idle");
    setEvents([]);
    setError(undefined);
    setDisconnected(false);
    setHasMore(false);
    clearStream();

    const applyDetail = (data: TaskDetail) => {
      setDetail(data);
      setStatus(data.runnerStatus);
      merge(
        data.openRequests.map(
          (request) => ({ ...request, seq: 0, ts: "", taskId, role: data.task.role }) as StoredEvent,
        ),
      );
    };

    const source = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`);
    source.onopen = () => {
      if (!active) return;
      setDisconnected(false);
      if (opened) {
        // Sambungan pulih: event yang terlewat sudah di-replay server; cukup segarkan header.
        void api.taskMeta(taskId).then((data) => active && applyDetail(data)).catch(() => undefined);
        return;
      }
      opened = true;
      api
        .task(taskId, { events: INITIAL_WINDOW })
        .then((data) => {
          if (!active) return;
          merge(data.events);
          setHasMore(Boolean(data.eventsHasMore));
          applyDetail(data);
        })
        .catch((cause: Error) => active && setError(cause.message));
    };
    source.onmessage = (message) => {
      if (!active) return;
      let event: StoredEvent;
      try {
        event = JSON.parse(message.data) as StoredEvent;
      } catch {
        return;
      }
      if (event.type === "status") {
        setStatus(event.status);
        if (event.status === "idle" || event.status === "error") clearStream();
        return;
      }
      if (event.type === "delta") {
        if (event.kind !== "text") return;
        streamBuffer.current += event.text;
        if (!flushTimer.current) {
          flushTimer.current = setTimeout(() => {
            flushTimer.current = undefined;
            if (active) setStreaming(streamBuffer.current);
          }, STREAM_FLUSH_MS);
        }
        return;
      }
      if (event.type === "assistant") clearStream();
      if (event.type === "result" || event.type === "handoff") {
        void api.taskMeta(taskId).then((fresh) => active && applyDetail(fresh)).catch(() => undefined);
      }
      merge([event]);
    };
    source.onerror = () => {
      if (!active) return;
      if (source.readyState === EventSource.CLOSED) setError("koneksi stream ditutup — muat ulang halaman");
      else setDisconnected(true);
    };

    return () => {
      active = false;
      source.close();
      clearStream();
    };
  }, [taskId, merge, clearStream]);

  // Perubahan dari aksi Anda (rename, mode, review…) cukup menyegarkan metadata —
  // transcript dan stream tidak disentuh, jadi tidak ada kedipan kosong.
  const firstRefresh = useRef(true);
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    const id = taskIdRef.current;
    if (!id) return;
    let active = true;
    void api
      .taskMeta(id)
      .then((data) => {
        if (!active) return;
        setDetail(data);
        setStatus(data.runnerStatus);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [refreshKey]);

  const loadOlder = useCallback(async () => {
    if (!taskId || loadingOlder || oldestSeq.current === undefined) return;
    setLoadingOlder(true);
    try {
      const data = await api.task(taskId, { events: OLDER_WINDOW, before: oldestSeq.current });
      merge(data.events);
      setHasMore(Boolean(data.eventsHasMore));
    } catch {
      // biarkan tombolnya; bisa dicoba lagi
    } finally {
      setLoadingOlder(false);
    }
  }, [taskId, loadingOlder, merge]);

  return { detail, events, status, streaming, error, disconnected, hasMore, loadingOlder, loadOlder };
}
