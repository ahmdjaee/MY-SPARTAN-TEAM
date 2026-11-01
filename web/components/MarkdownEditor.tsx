import { useEffect, useState } from "react";
import { renderMarkdown } from "../markdown.ts";

export type EditorView = "write" | "preview";

export function isEditorView(value: string | null): value is EditorView {
  return value === "write" || value === "preview";
}

/**
 * Editor Markdown dengan dua tab: Tulis dan Pratinjau.
 * Pratinjau selalu merender draf yang sedang diketik — bukan yang terakhir
 * disimpan — supaya apa yang Anda lihat benar-benar isi kotaknya.
 */
export function MarkdownEditor({
  value,
  note,
  view,
  onView,
  onSave,
  onDraft,
}: {
  value: string;
  note: string;
  view: EditorView;
  onView: (view: EditorView) => void;
  onSave: (text: string) => Promise<string>;
  /** Dipanggil setiap teks berubah — dipakai catatan tugas untuk menyimpan sendiri. */
  onDraft?: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const [saved, setSaved] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(value);
    setSaved(value);
  }, [value]);

  const dirty = text !== saved;

  const edit = (next: string) => {
    setText(next);
    onDraft?.(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await onSave(text);
      setText(next);
      setSaved(next);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex shrink-0 gap-1 text-xs">
          {(
            [
              ["write", "Tulis"],
              ["preview", "Pratinjau"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => onView(value)}
              className={`rounded-lg px-3 py-1.5 ${view === value ? "bg-hover text-ink" : "text-muted hover:bg-hover"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {dirty && (
          <span className="shrink-0 rounded bg-tag-yellow px-1.5 py-0.5 text-[11px] text-tag-yellow-ink">
            belum disimpan
          </span>
        )}
        <p className="min-w-0 flex-1 basis-40 text-xs text-muted">{note}</p>
        <button
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40"
        >
          {saving ? "Menyimpan…" : dirty ? "Simpan" : "Tersimpan"}
        </button>
      </div>

      {view === "write" ? (
        <textarea
          value={text}
          onChange={(e) => edit(e.target.value)}
          spellCheck={false}
          className="mt-3 min-h-0 flex-1 resize-none rounded-xl border border-line bg-page p-4 font-mono text-[13px] leading-relaxed text-ink outline-none focus:border-accent"
        />
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-line bg-page p-4">
          {text.trim() ? (
            <div className="markdown text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
          ) : (
            <p className="text-sm text-faint">(belum ada isi)</p>
          )}
        </div>
      )}
    </div>
  );
}
