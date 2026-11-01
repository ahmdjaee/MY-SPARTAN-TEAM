import { useEffect, useState } from "react";
import { MODE_LABEL, MODE_NOTE, api, type AutonomyMode, type RoleInfo, type Settings as SettingsData } from "../api.ts";
import { permissionState, requestPermission } from "../notifications.ts";

const MODES: AutonomyMode[] = ["auto", "ask", "readonly"];

const NOTIF_LABEL: Array<[keyof SettingsData["notifications"], string]> = [
  ["approval", "Kartu persetujuan muncul"],
  ["question", "Agen bertanya"],
  ["needsReview", "Tugas selesai & perlu dibaca"],
  ["failed", "Tugas gagal"],
];

export function Settings({ roles, onSaved }: { roles: RoleInfo[]; onSaved: (settings: SettingsData) => void }) {
  const [settings, setSettings] = useState<SettingsData>();
  const [permission, setPermission] = useState(permissionState());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.settings().then(setSettings);
  }, []);

  const save = async (patch: Partial<SettingsData>) => {
    setSaving(true);
    try {
      const next = await api.saveSettings(patch);
      setSettings(next);
      onSaved(next);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return <p className="p-6 text-sm text-faint">Memuat pengaturan…</p>;

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <h2 className="text-sm font-semibold text-ink">Pengaturan</h2>

      <section className="mt-5">
        <h3 className="text-xs uppercase tracking-wide text-muted">Mode bawaan tiap bot</h3>
        <p className="mt-1 text-xs text-faint">
          Berlaku untuk tugas baru. Tugas yang sudah berjalan diubah lewat pemilih Mode di header tugasnya.
        </p>
        <div className="mt-3 space-y-2">
          {roles.map((role) => (
            <div key={role.id} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
              <span className="w-44 shrink-0 text-sm text-ink">{role.title}</span>
              <div className="flex flex-wrap gap-1">
                {MODES.map((mode) => (
                  <button
                    key={mode}
                    disabled={saving}
                    onClick={() => void save({ modes: { ...settings.modes, [role.id]: mode } })}
                    title={MODE_NOTE[mode]}
                    className={`rounded-lg border px-2.5 py-1 text-xs ${
                      settings.modes[role.id] === mode
                        ? "border-accent bg-accent-soft text-accent-ink"
                        : "border-line text-muted hover:border-line-strong"
                    }`}
                  >
                    {MODE_LABEL[mode]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-faint">
          Di mode <strong className="text-muted">Auto</strong>, empat kategori ini tetap memunculkan kartu persetujuan:
          service &amp; container, data &amp; database, kredensial/firewall/akses, hapus berkas &amp; paket. Perintah
          katastrofik tetap ditolak tanpa bisa disetujui.
        </p>
      </section>

      <section className="mt-7">
        <div className="flex items-center gap-3">
          <h3 className="text-xs uppercase tracking-wide text-muted">Notifikasi browser</h3>
          {permission === "granted" ? (
            <span className="rounded bg-tag-green px-2 py-0.5 text-[11px] text-tag-green-ink">izin diberikan</span>
          ) : permission === "unsupported" ? (
            <span className="rounded bg-tag-gray px-2 py-0.5 text-[11px] text-tag-gray-ink">tidak didukung browser</span>
          ) : (
            <button
              onClick={async () => setPermission(await requestPermission())}
              className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover"
            >
              {permission === "denied" ? "Izin ditolak — buka setelan situs" : "Izinkan notifikasi"}
            </button>
          )}
        </div>

        <div className="mt-3 space-y-1.5">
          {NOTIF_LABEL.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={settings.notifications[key]}
                onChange={(e) =>
                  void save({ notifications: { ...settings.notifications, [key]: e.target.checked } })
                }
              />
              {label}
            </label>
          ))}
          <label className="flex items-center gap-2 border-t border-line pt-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={settings.notifications.onlyWhenHidden}
              onChange={(e) =>
                void save({ notifications: { ...settings.notifications, onlyWhenHidden: e.target.checked } })
              }
            />
            Hanya saat tab tidak aktif
          </label>
        </div>
        <p className="mt-2 text-xs text-faint">
          Jumlah tugas yang menunggu keputusan Anda selalu tampil di judul tab, mis. “(2) AI Team”.
        </p>
      </section>
    </div>
  );
}
