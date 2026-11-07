import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ContextUsage, type LiveState, type StoredEvent, type TaskDetail, type WorkerStatus } from "./api.ts";
import { onConnection, subscribe } from "./realtime.ts";

export type TaskThread = {
  detail?: TaskDetail;
  events: StoredEvent[];
  status: WorkerStatus;
  streaming: string;
  /** Pemakaian konteks live; kosong sampai sesi melaporkannya. */
  context?: ContextUsage;
  /** Keadaan browser bot (tab Live) — didorong server, tanpa polling. */
  live: LiveState;
  /** Naik setiap report.md ditulis atau turn selesai — tab Laporan memuat ulang. */
  reportRevision: number;
  /** Gagal memuat tugas (mis. id tidak ada). Putusnya sambungan bukan error — lihat `disconnected`. */
  error?: string;
  /** WebSocket sedang terputus dan browser mencoba menyambung ulang. */
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

const EPHEMERAL = new Set(["delta", "status", "context", "report_changed"]);

/**
 * Kunci dedupe. Permintaan terbuka datang lewat dua jalur: tersimpan di transcript (seq > 0) dan
 * dari `openRequests` (seq 0) — jadi kuncinya wajib id permintaan, apa pun seq-nya.
 */
export function keyOf(event: StoredEvent): string {
  if (event.type === "approval") return `approval:${event.approvalId}`;
  if (event.type === "question") return `question:${event.questionId}`;
  if (event.seq > 0) return `seq:${event.seq}`;
  const { ts: _ts, ...rest } = event;
  return `${event.type}:${JSON.stringify(rest).slice(0, 120)}`;
}

/** Seq tersimpan terbesar. Daftar selalu urut menurut seq (seq 0 boleh di mana saja), jadi cukup dicari dari ekor. */
export function lastSeqOf(list: StoredEvent[]): number {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const seq = list[i]?.seq ?? 0;
    if (seq > 0) return seq;
  }
  return 0;
}

/** Gabungkan event ke daftar: event yang sudah ada dilewati; salinan tersimpan menggantikan salinan seq 0. */
export function mergeEvents(previous: StoredEvent[], incoming: StoredEvent[]): StoredEvent[] {
  // Jalur cepat untuk event live: lebih baru dari semua yang ada → cukup ditempel, tanpa membangun indeks.
  // Kartu permintaan dikecualikan karena salinan tersimpannya harus menggantikan salinan seq 0.
  if (incoming.length === 1) {
    const event = incoming[0]!;
    if (EPHEMERAL.has(event.type)) return previous;
    if (event.seq > 0 && event.type !== "approval" && event.type !== "question" && event.seq > lastSeqOf(previous)) {
      return [...previous, event];
    }
  }
  const index = new Map(previous.map((event, position) => [keyOf(event), position]));
  const next = [...previous];
  let lastSeq = lastSeqOf(previous);
  let unordered = false;
  let changed = false;
  for (const event of incoming) {
    if (EPHEMERAL.has(event.type)) continue;
    const key = keyOf(event);
    const position = index.get(key);
    if (position !== undefined) {
      if (next[position]?.seq !== 0 || event.seq === 0) continue;
      next[position] = event;
      unordered = true;
    } else {
      index.set(key, next.length);
      next.push(event);
      if (event.seq > 0 && event.seq < lastSeq) unordered = true;
    }
    changed = true;
    if (event.seq > lastSeq) lastSeq = event.seq;
  }
  if (!changed) return previous;
  // Event replay/jendela lama bisa datang setelah event live; seq 0 (permintaan terbuka) tetap di akhir.
  if (unordered) next.sort((a, b) => (a.seq || Infinity) - (b.seq || Infinity));
  return next;
}

/** Event topik `task:<id>` yang bukan bagian transcript. */
type StreamEvent =
  | StoredEvent
  | ({ type: "live" } & LiveState)
  | { type: "task_changed" }
  | { type: "resync" };

/** Tanpa WebSocket (mis. proxy belum meneruskan Upgrade) isi tugas tetap tampil, hanya tidak live. */
const FALLBACK_MS = 4_000;
/** Status, result, dan task.json sering berubah beruntun; header cukup disegarkan sekali. */
const META_DEBOUNCE_MS = 400;

/**
 * Memuat detail tugas lalu menyimak event-nya lewat WebSocket (topik `task:<id>`).
 *
 * Urutannya: langganan dipasang dulu, snapshot diambil saat server mengirim `ready` — jadi tidak
 * ada event yang jatuh di antara keduanya. Saat sambungan pulih, langganan dikirim ulang dengan
 * `after` = seq tersimpan terakhir dan server me-replay yang terlewat; cukup menyegarkan metadata.
 */
export function useTaskThread(taskId: string | undefined, refreshKey: number): TaskThread {
  const [detail, setDetail] = useState<TaskDetail>();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [status, setStatus] = useState<WorkerStatus>("idle");
  const [streaming, setStreaming] = useState("");
  const [context, setContext] = useState<ContextUsage>();
  const [live, setLive] = useState<LiveState>({ active: false });
  const [reportRevision, setReportRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [disconnected, setDisconnected] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const streamBuffer = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const oldestSeq = useRef<number | undefined>(undefined);
  /** Seq tersimpan terbesar yang sudah dimiliki — dikirim sebagai `after` saat menyambung ulang. */
  const lastSeq = useRef(0);

  const merge = useCallback((incoming: StoredEvent[]) => {
    for (const event of incoming) {
      if (EPHEMERAL.has(event.type) || event.seq <= 0) continue;
      if (oldestSeq.current === undefined || event.seq < oldestSeq.current) oldestSeq.current = event.seq;
      if (event.seq > lastSeq.current) lastSeq.current = event.seq;
    }
    setEvents((previous) => mergeEvents(previous, incoming));
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
    /** Jendela awal sudah digabung: `lastSeq` sah dipakai sebagai `after`. */
    let baseline = false;
    /** `after` yang dikirim di langganan terakhir; undefined = server tidak me-replay apa pun. */
    let sentAfter: number | undefined;
    let ready = false;
    let metaTimer: ReturnType<typeof setTimeout> | undefined;
    oldestSeq.current = undefined;
    lastSeq.current = 0;
    setDetail(undefined);
    setStatus("idle");
    setContext(undefined);
    setLive({ active: false });
    setEvents([]);
    setError(undefined);
    setDisconnected(false);
    setHasMore(false);
    clearStream();

    const applyDetail = (data: TaskDetail) => {
      setDetail(data);
      setStatus(data.runnerStatus);
      setLive(data.live);
      merge(
        data.openRequests.map(
          (request) => ({ ...request, seq: 0, ts: "", taskId, role: data.task.role }) as StoredEvent,
        ),
      );
    };

    const loadWindow = (reset: boolean) => {
      // Dikosongkan SEBELUM mengambil jendela: event live yang datang selama fetch ikut tergabung,
      // bukan ikut terhapus saat jawabannya tiba.
      if (reset) {
        oldestSeq.current = undefined;
        lastSeq.current = 0;
        setEvents([]);
      }
      api
        .task(taskId, { events: INITIAL_WINDOW })
        .then((data) => {
          if (!active) return;
          merge(data.events);
          setHasMore(Boolean(data.eventsHasMore));
          applyDetail(data);
          baseline = true;
          setError(undefined);
        })
        .catch((cause: Error) => active && !baseline && setError(cause.message));
    };

    const refreshMeta = () => {
      if (metaTimer) return;
      metaTimer = setTimeout(() => {
        metaTimer = undefined;
        void api
          .taskMeta(taskId)
          .then((fresh) => active && applyDetail(fresh))
          .catch(() => undefined);
      }, META_DEBOUNCE_MS);
    };

    const fallback = setTimeout(() => {
      if (active && !ready && !baseline) loadWindow(false);
    }, FALLBACK_MS);

    const unsubscribe = subscribe<StreamEvent>(
      `task:${taskId}`,
      (event) => {
        if (!active) return;
        if (event.type === "status") {
          setStatus(event.status);
          if (event.status === "idle" || event.status === "error") clearStream();
          return;
        }
        if (event.type === "context") {
          setContext({ usedTokens: event.usedTokens, maxTokens: event.maxTokens, percentage: event.percentage });
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
        if (event.type === "live") {
          const { type: _type, ...state } = event;
          setLive(state);
          return;
        }
        if (event.type === "task_changed") {
          refreshMeta();
          return;
        }
        if (event.type === "resync") {
          // Tertinggal terlalu jauh untuk di-replay: ganti dengan jendela terbaru.
          baseline = false;
          loadWindow(true);
          return;
        }
        if (event.type === "report_changed") {
          setReportRevision((value) => value + 1);
          return;
        }
        if (event.type === "assistant") clearStream();
        // Penugasan baru punya sesi baru: angka bot sebelumnya tidak berlaku lagi.
        if (event.type === "handoff") setContext(undefined);
        if (event.type === "result" || event.type === "handoff") {
          refreshMeta();
          setReportRevision((value) => value + 1);
        }
        merge([event]);
      },
      {
        after: () => {
          sentAfter = baseline ? lastSeq.current : undefined;
          return sentAfter;
        },
        onReady: () => {
          if (!active) return;
          setDisconnected(false);
          ready = true;
          // Dengan `after`, server sudah me-replay yang terlewat. Tanpa `after` tidak ada replay:
          // jendela diambil sesudah `ready`, jadi event di antaranya tetap tertangkap langganan.
          if (sentAfter === undefined) loadWindow(false);
          else refreshMeta();
        },
        onError: (message) => active && setError(message),
      },
    );
    const offConnection = onConnection((connected) => {
      if (active && !connected) setDisconnected(true);
    });

    return () => {
      active = false;
      clearTimeout(fallback);
      if (metaTimer) clearTimeout(metaTimer);
      unsubscribe();
      offConnection();
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
        setLive(data.live);
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

  return {
    detail,
    events,
    status,
    streaming,
    context,
    live,
    reportRevision,
    error,
    disconnected,
    hasMore,
    loadingOlder,
    loadOlder,
  };
}
