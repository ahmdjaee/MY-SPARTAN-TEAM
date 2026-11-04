import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.ts";
import { MarkdownEditor, isEditorView, type EditorView } from "./MarkdownEditor.tsx";

const NOTE =
  "Catatan pribadi untuk tugas ini — tidak pernah dikirim ke bot. Tersimpan sendiri saat Anda berpindah tab.";

/**
 * Catatan satu tugas. Berbeda dengan konteks project yang dibuka khusus untuk
 * disunting, catatan ditulis sambil berpindah-pindah tab — jadi draf yang belum
 * disimpan ikut terkirim saat komponen ditinggalkan atau halaman ditutup.
 */
export function TaskNotes({ taskId, onSaved }: { taskId: string; onSaved: () => void }) {
  const [text, setText] = useState<string>();
  const [search, setSearch] = useSearchParams();
  const viewFromUrl = search.get("view");
  const view: EditorView = isEditorView(viewFromUrl) ? viewFromUrl : "write";
  /** Teks terakhir yang sudah sampai ke server; dibandingkan saat menyimpan otomatis. */
  const pending = useRef<{ taskId: string; saved: string; draft: string }>({ taskId, saved: "", draft: "" });
  // onSaved milik render terbaru — cleanup effect di bawah tidak boleh memakai versi render pertama.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    let active = true;
    // Pindah tugas: draf tugas sebelumnya disimpan dulu sebelum ref-nya ditimpa.
    if (pending.current.taskId !== taskId) flush(true);
    setText(undefined);
    void api.taskNotes(taskId).then((data) => {
      if (!active) return;
      setText(data.text);
      pending.current = { taskId, saved: data.text, draft: data.text };
    });
    return () => {
      active = false;
    };
  }, [taskId]);

  // Satu jalur simpan untuk tombol, perpindahan tab, dan penutupan halaman.
  const flush = (keepalive = false) => {
    const { taskId: id, saved, draft } = pending.current;
    if (draft === saved) return;
    pending.current.saved = draft;
    void fetch(`/api/tasks/${encodeURIComponent(id)}/notes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: draft }),
      keepalive,
    })
      .then(() => onSavedRef.current())
      .catch(() => undefined);
  };

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      flush(true);
    };
  }, []);

  const setView = (next: EditorView) => {
    const params = new URLSearchParams(search);
    params.set("view", next);
    setSearch(params, { replace: true });
  };

  if (text === undefined) return <p className="p-6 text-sm text-faint">Memuat catatan…</p>;

  return (
    <div className="flex h-full flex-col px-6 py-5">
      <MarkdownEditor
        value={text}
        view={view}
        onView={setView}
        note={NOTE}
        onDraft={(draft) => {
          pending.current.draft = draft;
        }}
        onSave={async (next) => {
          const saved = (await api.saveTaskNotes(taskId, next)).text;
          pending.current = { taskId, saved, draft: saved };
          onSaved();
          return saved;
        }}
      />
    </div>
  );
}
