import { useEffect, useRef, useState } from "react";
import { api, type StoredEvent, type TaskDetail, type WorkerStatus } from "./api.ts";

export type TaskThread = {
  detail?: TaskDetail;
  events: StoredEvent[];
  status: WorkerStatus;
  streaming: string;
  error?: string;
};

/** Memuat detail tugas lalu menyimak event-nya lewat SSE. */
export function useTaskThread(taskId: string | undefined, refreshKey: number): TaskThread {
  const [detail, setDetail] = useState<TaskDetail>();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [status, setStatus] = useState<WorkerStatus>("idle");
  const [streaming, setStreaming] = useState("");
  const [error, setError] = useState<string>();
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!taskId) return;
    let active = true;
    seen.current = new Set();
    setEvents([]);
    setStreaming("");
    setError(undefined);

    const key = (event: StoredEvent): string =>
      event.seq > 0 ? `seq:${event.seq}` : `${event.type}:${JSON.stringify(event).slice(0, 120)}`;

    const append = (incoming: StoredEvent[]) => {
      setEvents((previous) => {
        const next = [...previous];
        for (const event of incoming) {
          const id = key(event);
          if (seen.current.has(id)) continue;
          seen.current.add(id);
          next.push(event);
        }
        return next;
      });
    };

    api
      .task(taskId)
      .then((data) => {
        if (!active) return;
        setDetail(data);
        setStatus(data.runnerStatus);
        append(data.events);
        append(
          data.openRequests.map(
            (request) =>
              ({ ...request, seq: 0, ts: new Date().toISOString(), taskId, role: data.task.role }) as StoredEvent,
          ),
        );
      })
      .catch((cause: Error) => active && setError(cause.message));

    const source = new EventSource(`/api/tasks/${taskId}/events`);
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
        if (event.status === "idle" || event.status === "error") setStreaming("");
        return;
      }
      if (event.type === "delta") {
        if (event.kind === "text") setStreaming((previous) => previous + event.text);
        return;
      }
      if (event.type === "assistant") setStreaming("");
      if (event.type === "result" || event.type === "handoff") {
        void api.task(taskId).then((fresh) => active && setDetail(fresh));
      }
      append([event]);
    };
    source.onerror = () => active && setError("koneksi stream terputus — muat ulang halaman");

    return () => {
      active = false;
      source.close();
    };
  }, [taskId, refreshKey]);

  return { detail, events, status, streaming, error };
}
