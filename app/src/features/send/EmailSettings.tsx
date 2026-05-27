import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type EmailSettings = {
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  smtp_from_name: string;
  booking_url: string;
};

const PRESETS = [
  { label: "Gmail", host: "smtp.gmail.com", port: 587 },
  { label: "Outlook / Microsoft 365", host: "smtp-mail.outlook.com", port: 587 },
  { label: "Yahoo Mail", host: "smtp.mail.yahoo.com", port: 587 },
  { label: "Custom SMTP", host: "", port: 587 },
];

const EMPTY: EmailSettings = {
  smtp_host: "",
  smtp_port: 587,
  smtp_user: "",
  smtp_password: "",
  smtp_from_name: "",
  booking_url: "",
};

export function EmailSettings() {
  const [settings, setSettings] = useState<EmailSettings>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState("Configure your email delivery settings below.");
  const [showPassword, setShowPassword] = useState(false);
  const [bookingStatus, setBookingStatus] = useState("");

  useEffect(() => {
    invoke<EmailSettings>("get_email_settings")
      .then((s) => setSettings(s))
      .catch(() => setSettings(EMPTY));
  }, []);

  function applyPreset(preset: (typeof PRESETS)[0]) {
    setSettings((prev) => ({
      ...prev,
      smtp_host: preset.host,
      smtp_port: preset.port,
    }));
  }

  async function save() {
    setSaving(true);
    setStatus("Saving...");
    try {
      await invoke("set_email_settings", { payload: settings });
      setStatus("Email settings saved.");
    } catch (e) {
      setStatus(`Could not save settings: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setStatus("Sending test email — this may take a few seconds...");
    try {
      const msg = await invoke<string>("test_smtp_connection");
      setStatus(msg);
    } catch (e) {
      setStatus(`Connection failed: ${String(e)}`);
    } finally {
      setTesting(false);
    }
  }

  async function saveBooking() {
    setBookingStatus("Saving...");
    try {
      await invoke("set_email_settings", { payload: settings });
      setBookingStatus("Booking link saved.");
    } catch (e) {
      setBookingStatus(`Could not save: ${String(e)}`);
    }
  }

  const isConfigured =
    settings.smtp_host.trim() !== "" && settings.smtp_user.trim() !== "";

  return (
    <>
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="eyebrow">Email delivery</div>
            <h2>Connect your email account</h2>
            <p>
              Use any SMTP-compatible email account — Gmail, Outlook, or your business email provider.
              Once configured, approved drafts can be sent directly from this workspace.
            </p>
          </div>
          <div className={isConfigured ? "panel-chip success" : "panel-chip"}>
            {isConfigured ? "Configured" : "Not yet configured"}
          </div>
        </div>

        <div className="provider-preset-row">
          <span className="eyebrow">Quick setup</span>
          <div className="preset-chips">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="preset-chip"
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {settings.smtp_host === "smtp.gmail.com" && (
          <div className="notice-card calm gmail-guide">
            <strong>Gmail setup guide</strong>
            <p>
              Gmail requires an <strong>App Password</strong> — not your regular password.
              To create one: go to <em>myaccount.google.com</em> → <em>Security</em> → <em>How you sign in to Google</em> → <em>2-Step Verification</em>, then scroll to the bottom of that page and click <em>App passwords</em>.
              Generate one for "Mail", copy the 16-character code, and paste it in the Password field below.
            </p>
            <p style={{marginTop: "6px", fontSize: "0.8rem", color: "var(--ink-300)"}}>
              Note: App passwords only appear if 2-Step Verification is already turned on and your account is not using passkeys-only sign-in.
            </p>
          </div>
        )}

        <div className="form-grid two-col">
          <label className="mapping-row">
            <span>SMTP host</span>
            <input
              value={settings.smtp_host}
              onChange={(e) => setSettings((p) => ({ ...p, smtp_host: e.target.value }))}
              placeholder="smtp.gmail.com"
            />
          </label>
          <label className="mapping-row">
            <span>Port</span>
            <select
              value={settings.smtp_port}
              onChange={(e) =>
                setSettings((p) => ({ ...p, smtp_port: Number(e.target.value) }))
              }
            >
              <option value={587}>587 — STARTTLS (recommended)</option>
              <option value={465}>465 — SSL</option>
              <option value={25}>25 — Plain (not recommended)</option>
            </select>
          </label>
          <label className="mapping-row">
            <span>Email address (username)</span>
            <input
              type="email"
              value={settings.smtp_user}
              onChange={(e) => setSettings((p) => ({ ...p, smtp_user: e.target.value }))}
              placeholder="you@gmail.com"
            />
          </label>
          <label className="mapping-row">
            <span>Password / App password</span>
            <div className="password-field">
              <input
                type={showPassword ? "text" : "password"}
                value={settings.smtp_password}
                onChange={(e) =>
                  setSettings((p) => ({ ...p, smtp_password: e.target.value }))
                }
                placeholder="Paste your app password here"
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </label>
          <label className="mapping-row full-span">
            <span>Display name (shown as sender)</span>
            <input
              value={settings.smtp_from_name}
              onChange={(e) =>
                setSettings((p) => ({ ...p, smtp_from_name: e.target.value }))
              }
              placeholder="Jane Smith, CEO — Acme Inc."
            />
          </label>
        </div>

        <div className="panel-actions wrap">
          <button
            type="button"
            className="primary-button"
            onClick={save}
            disabled={saving || testing}
          >
            {saving ? "Saving..." : "Save settings"}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={test}
            disabled={saving || testing || !isConfigured}
          >
            {testing ? "Sending test..." : "Send test email"}
          </button>
        </div>
        <p className="status idle">{status}</p>

        <div className="notice-card calm">
          <strong>Privacy note</strong>
          <p>
            Your credentials are stored locally on this device only. Nothing is sent to any cloud
            service. Emails go directly from your device to your SMTP server.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="eyebrow">Appointment booking</div>
            <h2>Tour scheduling link</h2>
            <p>
              Add your Calendly, Cal.com, or any booking page URL. It will be automatically
              included in every email sent through this app so prospects can schedule a tour
              directly from their inbox.
            </p>
          </div>
          {settings.booking_url && <div className="panel-chip success">Link set</div>}
        </div>

        <div className="form-grid">
          <label className="mapping-row">
            <span>Booking / Tour scheduling link</span>
            <input
              type="url"
              value={settings.booking_url}
              onChange={(e) =>
                setSettings((p) => ({ ...p, booking_url: e.target.value }))
              }
              placeholder="https://calendly.com/your-name/workspace-tour"
            />
          </label>
        </div>

        {settings.booking_url && (
          <div className="notice-card calm">
            <strong>How this works</strong>
            <p>
              When the AI generates email drafts, it will naturally include this link as the
              call-to-action. When emails are sent, the link is also appended to any draft
              that doesn't already contain it — so every recipient gets a clear path to booking.
            </p>
          </div>
        )}

        <div className="booking-service-row">
          <span className="eyebrow">Free booking services</span>
          <div className="preset-chips">
            <a
              href="https://calendly.com"
              target="_blank"
              rel="noopener noreferrer"
              className="preset-chip"
            >
              Calendly (free tier)
            </a>
            <a
              href="https://cal.com"
              target="_blank"
              rel="noopener noreferrer"
              className="preset-chip"
            >
              Cal.com (free & open source)
            </a>
          </div>
        </div>

        <div className="panel-actions">
          <button
            type="button"
            className="primary-button"
            onClick={saveBooking}
          >
            Save booking link
          </button>
        </div>
        {bookingStatus && <p className="status idle">{bookingStatus}</p>}
      </div>
    </>
  );
}
