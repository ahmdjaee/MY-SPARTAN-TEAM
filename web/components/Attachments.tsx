import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, docRawUrl, type DocContent, type DocInfo } from "../api.ts";
import { renderMarkdown } from "../markdown.ts";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

/** Kelompokkan per folder, urutan folder mengikuti urutan daftar dari server (akar lebih dulu). */
function groupByFolder(docs: DocInfo[]): { folder: string; docs: DocInfo[] }[] {
  const groups: { folder: string; docs: DocInfo[] }[] = [];
  for (const doc of docs) {
    const slash = doc.path.lastIndexOf("/");
    const folder = slash < 0 ? "" : doc.path.slice(0, slash + 1);
    const group = groups.find((item) => item.folder === folder);
    if (group) group.docs.push(doc);
    else groups.push({ folder, docs: [doc] });
  }
  return groups;
}

/** Lampiran tugas: berkas teks di folder tugas selain report.md dan gambar bukti. */
export function Attachments({ taskId, docs }: { taskId: string; docs: DocInfo[] }) {
  const [content, setContent] = useState<DocContent>();
  const [error, setError] = useState<string>();
  // Pindah-pindah berkas tidak perlu memanggil server lagi.
  const cache = useRef(new Map<string, DocContent>());

  // Berkas yang sedang dibaca ikut di alamat (`?doc=`), jadi refresh tidak melempar
  // Anda balik ke berkas pertama dan satu lampiran bisa ditunjuk lewat tautan.
  const [search, setSearch] = useSearchParams();
  const fromUrl = search.get("doc");
  const selected = docs.some((doc) => doc.path === fromUrl) ? (fromUrl as string) : docs[0]?.path;

  const select = (path: string) => {
    const next = new URLSearchParams(search);
    next.set("doc", path);
    // Membaca sepuluh lampiran tidak boleh jadi sepuluh langkah Back.
    setSearch(next, { replace: true });
  };

  useEffect(() => {
    cache.current = new Map();
  }, [taskId]);

  useEffect(() => {
    if (!selected) {
      setContent(undefined);
      return;
    }
    const cached = cache.current.get(selected);
    setError(undefined);
    setContent(cached);
    if (cached) return;
    let active = true;
    void api
      .taskDoc(taskId, selected)
      .then((fresh) => {
        cache.current.set(selected, fresh);
        if (active) setContent(fresh);
      })
      .catch((cause: Error) => active && setError(cause.message));
    return () => {
      active = false;
    };
  }, [taskId, selected]);

  if (docs.length === 0) {
    return (
      <div className="h-full overflow-y-auto px-6 py-5">
        <p className="rounded-lg border border-line bg-panel p-3 text-sm text-muted">
          Tugas ini belum punya lampiran. Berkas apa pun selain `report.md` dan gambar bukti yang ditulis agen ke folder
          tugas akan muncul di sini.
        </p>
      </div>
    );
  }

  const isMarkdown = selected?.toLowerCase().endsWith(".md") ?? false;

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-line py-3">
        {groupByFolder(docs).map((group) => (
          <div key={group.folder || "."} className="mb-2">
            {group.folder && (
              <h3 className="px-3 py-1 font-mono text-[11px] uppercase tracking-wide text-faint">{group.folder}</h3>
            )}
            {group.docs.map((doc) => {
              const name = doc.path.slice(doc.path.lastIndexOf("/") + 1);
              return (
                <button
                  key={doc.path}
                  onClick={() => select(doc.path)}
                  className={`block w-full px-3 py-1.5 text-left ${
                    selected === doc.path ? "bg-hover text-ink" : "text-muted hover:bg-hover"
                  }`}
                >
                  <span className="block truncate text-xs">{name}</span>
                  <span className="block text-[11px] text-faint">
                    {formatSize(doc.size)} · {formatDate(doc.mtime)}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="flex items-center gap-3 border-b border-line px-6 py-2">
          <span className="truncate font-mono text-xs text-muted">{selected}</span>
          {selected && (
            <a
              href={docRawUrl(taskId, selected)}
              className="ml-auto shrink-0 rounded-lg border border-line-strong px-2 py-1 text-xs text-ink hover:bg-hover"
            >
              Unduh
            </a>
          )}
        </div>

        <div className="px-6 py-5">
          {error && <p className="rounded-lg border border-line bg-tag-red p-3 text-sm text-tag-red-ink">{error}</p>}
          {!error && !content && <p className="text-sm text-faint">Memuat…</p>}
          {content?.binary && (
            <p className="rounded-lg border border-line bg-panel p-3 text-sm text-muted">
              Bukan berkas teks — pakai tombol Unduh untuk membukanya di luar aplikasi.
            </p>
          )}
          {content?.truncated && (
            <p className="mb-3 rounded-lg border border-line bg-tag-yellow p-2 text-xs text-tag-yellow-ink">
              Hanya 512 KB pertama yang ditampilkan — unduh untuk versi penuh.
            </p>
          )}
          {content?.text !== undefined &&
            (isMarkdown ? (
              <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(content.text, taskId) }} />
            ) : (
              <pre className="overflow-x-auto rounded-lg border border-line bg-page p-3 font-mono text-xs leading-relaxed text-ink">
                {content.text}
              </pre>
            ))}
        </div>
      </section>
    </div>
  );
}
