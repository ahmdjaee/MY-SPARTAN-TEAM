import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.ts";
import { MarkdownEditor, isEditorView, type EditorView } from "./MarkdownEditor.tsx";

export function Memory() {
  const [text, setText] = useState<string>();
  const [search, setSearch] = useSearchParams();
  const viewFromUrl = search.get("view");
  const view: EditorView = isEditorView(viewFromUrl) ? viewFromUrl : "write";

  useEffect(() => {
    void api.memory().then((data) => setText(data.text));
  }, []);

  const setView = (next: EditorView) => {
    const params = new URLSearchParams(search);
    params.set("view", next);
    setSearch(params, { replace: true });
  };

  if (text === undefined) return <p className="p-6 text-sm text-faint">Memuat memori…</p>;

  return (
    <div className="flex h-full flex-col px-6 py-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Memori global</h2>
      <div className="min-h-0 flex-1">
        <MarkdownEditor
          value={text}
          view={view}
          onView={setView}
          note="Dibaca semua bot di semua project. Catatan khusus satu proyek ada di halaman Project → Memori project — ke sana pula tool `remember` milik bot menulis."
          onSave={async (next) => (await api.saveMemory(next)).text}
        />
      </div>
    </div>
  );
}
