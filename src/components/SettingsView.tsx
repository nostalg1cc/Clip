import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type AppSettings = {
  version: string;
  autostart: boolean;
  theme: "system" | "light" | "dark";
  backdrop: "acrylic" | "mica" | "adaptive";
  alwaysOnTop: boolean;
  winVOverride: boolean;
  localsendEnabled: boolean;
  localsendAlias: string;
  localsendAddress: string | null;
  localsendFingerprint: string;
  purgeHours: number;
};

const DEFAULT_SETTINGS: AppSettings = {
  version: "",
  autostart: false,
  theme: "system",
  backdrop: "acrylic",
  alwaysOnTop: true,
  winVOverride: false,
  localsendEnabled: false,
  localsendAlias: "Clip",
  localsendAddress: null,
  localsendFingerprint: "",
  purgeHours: 24,
};

function boolValue(enabled: boolean): string {
  return enabled ? "1" : "0";
}

export function SettingsView({ notify }: { notify: (msg: string) => void }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_app_settings")
      .then(setSettings)
      .catch(() => notify("Couldn't load settings"))
      .finally(() => setLoading(false));
  }, [notify]);

  const setSetting = async (key: string, value: string) => {
    setSaving(key);
    try {
      const next = await invoke<AppSettings>("set_app_setting", { key, value });
      setSettings(next);
    } catch {
      notify("Couldn't save setting");
    } finally {
      setSaving(null);
    }
  };

  const updateLocal = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((cur) => ({ ...cur, [key]: value }));
  };

  if (loading) return <div className="settings-view"><div className="settings-empty">Loading settings...</div></div>;

  return (
    <div className="settings-view">
      <section className="settings-section">
        <div className="settings-section-title">App</div>
        <label className="settings-row">
          <span>Theme</span>
          <select value={settings.theme} onChange={(e) => setSetting("theme", e.target.value)}>
            <option value="system">Follow Windows</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label className="settings-row">
          <span>Backdrop</span>
          <select value={settings.backdrop} onChange={(e) => setSetting("backdrop", e.target.value)}>
            <option value="acrylic">Acrylic</option>
            <option value="mica">Mica</option>
            <option value="adaptive">Adaptive Acrylic</option>
          </select>
        </label>
        <label className="settings-row toggle">
          <span>Always on top</span>
          <input type="checkbox" checked={settings.alwaysOnTop} onChange={(e) => setSetting("always_on_top", boolValue(e.target.checked))} />
        </label>
        <label className="settings-row toggle">
          <span>Run at startup</span>
          <input type="checkbox" checked={settings.autostart} onChange={(e) => setSetting("autostart", boolValue(e.target.checked))} />
        </label>
        <label className="settings-row toggle">
          <span>Use Win+V shortcut</span>
          <input type="checkbox" checked={settings.winVOverride} onChange={(e) => setSetting("win_v_override", boolValue(e.target.checked))} />
        </label>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">LocalSend</div>
        <label className="settings-row toggle">
          <span>Enable send and receive</span>
          <input type="checkbox" checked={settings.localsendEnabled} onChange={(e) => setSetting("localsend_enabled", boolValue(e.target.checked))} />
        </label>
        <label className="settings-row">
          <span>Device name</span>
          <input
            value={settings.localsendAlias}
            onChange={(e) => updateLocal("localsendAlias", e.target.value)}
            onBlur={() => setSetting("localsend_alias", settings.localsendAlias)}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
        </label>
        <div className="settings-row info">
          <span>This device</span>
          <code>{settings.localsendAddress ?? "No LAN address"}</code>
        </div>
        <div className="settings-row info">
          <span>Fingerprint</span>
          <code>{settings.localsendFingerprint ? settings.localsendFingerprint.slice(0, 12) : "Unavailable"}</code>
        </div>
        <div className="settings-note">Use this device address when adding Clip manually from the LocalSend mobile app. Incoming LocalSend files are currently accepted automatically while LocalSend is enabled.</div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">Cleanup</div>
        <label className="settings-row">
          <span>Purge unpinned after</span>
          <select value={settings.purgeHours} onChange={(e) => setSetting("purge_hours", e.target.value)}>
            <option value={1}>1 hour</option>
            <option value={6}>6 hours</option>
            <option value={12}>12 hours</option>
            <option value={24}>24 hours</option>
            <option value={48}>2 days</option>
            <option value={168}>7 days</option>
            <option value={720}>30 days</option>
          </select>
        </label>
        <div className="settings-note">Pinned clips are kept. Download files are removed with their unpinned clip.</div>
      </section>

      <section className="settings-section version-section">
        <div>
          <div className="settings-section-title">Version</div>
          <div className="settings-version">Clip {settings.version}</div>
        </div>
        {saving && <div className="settings-saving">Saving...</div>}
      </section>
    </div>
  );
}