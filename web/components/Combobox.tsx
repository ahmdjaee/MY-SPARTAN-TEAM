import { useEffect, useMemo, useRef, useState } from "react";

export type ComboOption = {
  value: string;
  label: string;
  /** Baris kedua kecil di bawah label (mis. folder workspace); ikut dicari. */
  hint?: string;
  badge?: string;
};

/**
 * Combobox yang bisa dicari — pola yang sama dengan combobox shadcn
 * (tombol pemicu → panel → kotak cari → daftar dengan tanda ✓), tapi tanpa
 * dependensi baru: panel, pencarian, dan navigasi papan ketik ditulis di sini.
 */
export function Combobox({
  value,
  options,
  onChange,
  placeholder = "Pilih…",
  searchPlaceholder = "Cari…",
  emptyText = "Tidak ada yang cocok.",
  action,
  title,
  ariaLabel,
  className = "",
  compact = false,
}: {
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Baris terakhir yang bukan pilihan, mis. "+ Project baru…". */
  action?: { label: string; onSelect: () => void };
  title?: string;
  ariaLabel?: string;
  className?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(needle));
  }, [options, query]);

  // Jumlah baris yang bisa disorot: hasil filter + baris aksi (kalau ada dan pencarian kosong).
  const showAction = Boolean(action) && !query.trim();
  const rowCount = filtered.length + (showAction ? 1 : 0);

  // Pilihan & daftar dibaca lewat ref: `options` dibuat ulang tiap render induk
  // (daftar tugas di-poll 3 detik sekali), dan kalau efek ini ikut bergantung
  // padanya, kotak cari yang sedang Anda isi akan terhapus sendiri.
  const latest = useRef({ options, value });
  latest.current = { options, value };
  useEffect(() => {
    if (!open) return;
    setQuery("");
    const index = latest.current.options.findIndex((option) => option.value === latest.current.value);
    setActive(index >= 0 ? index : 0);
  }, [open]);

  // Klik di luar menutup panel — sama seperti popover.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (index: number) => {
    if (showAction && index === filtered.length) {
      setOpen(false);
      action?.onSelect();
      return;
    }
    const option = filtered[index];
    if (!option) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rowCount === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + rowCount) % rowCount);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pick(active);
    }
  };

  const pad = compact ? "px-2 py-1" : "px-3 py-2";

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title ?? selected?.hint}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex w-full items-center gap-1.5 rounded-lg border border-line bg-page ${pad} text-left ${
          compact ? "text-xs" : "text-sm"
        } text-ink hover:border-line-strong`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium" : "text-muted"}`}>
          {selected?.label ?? placeholder}
        </span>
        {selected?.badge && (
          <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-muted">{selected.badge}</span>
        )}
        <span className="shrink-0 text-muted">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-xl border border-line bg-raised shadow-2xl">
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="w-full border-b border-line bg-transparent px-3 py-2 text-xs text-ink outline-none placeholder:text-faint"
          />
          <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && !showAction && <p className="px-3 py-2 text-xs text-faint">{emptyText}</p>}
            {filtered.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                data-active={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(index)}
                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left ${
                  index === active ? "bg-hover" : ""
                }`}
              >
                <span className={`w-3 shrink-0 text-xs ${option.value === value ? "text-accent-ink" : "text-transparent"}`}>
                  ✓
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-ink">{option.label}</span>
                  {option.hint && <span className="block truncate font-mono text-[10px] text-faint">{option.hint}</span>}
                </span>
                {option.badge && (
                  <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-muted">{option.badge}</span>
                )}
              </button>
            ))}
            {showAction && action && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-active={active === filtered.length}
                onMouseEnter={() => setActive(filtered.length)}
                onClick={() => pick(filtered.length)}
                className={`mt-1 flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-xs text-accent-ink ${
                  active === filtered.length ? "bg-hover" : ""
                }`}
              >
                {action.label}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
