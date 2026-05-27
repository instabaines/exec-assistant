import { useState, type ChangeEvent, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

type Props = {
  onComplete: () => void;
};

type Field = { name: string; position: string; company: string };

export function WelcomeSetup({ onComplete }: Props) {
  const [form, setForm] = useState<Field>({ name: "", position: "", company: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function update(e: ChangeEvent<HTMLInputElement>) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  const canSubmit = form.name.trim() && form.position.trim() && form.company.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || saving) return;
    setError("");
    setSaving(true);
    try {
      const existing = await invoke<{
        model: string;
        default_system_prompt: string;
        sender_name: string;
        sender_position: string;
        sender_company: string;
      }>("get_generation_settings");

      await invoke("set_generation_settings", {
        payload: {
          model: existing.model,
          default_system_prompt: existing.default_system_prompt,
          sender_name: form.name.trim(),
          sender_position: form.position.trim(),
          sender_company: form.company.trim(),
        },
      });
      onComplete();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  return (
    <div className="welcome-shell">
      <div className="welcome-left">
        <div className="welcome-brand">
          <img src="/src/assets/logo.png" alt="Exec Assistant AI" className="welcome-logo" />
        </div>
        <div className="welcome-pitch">
          <h1>Your private executive assistant.</h1>
          <p>
            Outreach, pipeline, tasks, and documents — all powered by AI that runs entirely
            on your device. No cloud. No subscriptions. No data leaving your machine.
          </p>
        </div>
        <ul className="welcome-pillars">
          <li>
            <span className="welcome-pillar-icon">✦</span>
            <span>Personalised emails drafted in seconds</span>
          </li>
          <li>
            <span className="welcome-pillar-icon">✦</span>
            <span>Pipeline, tasks, and meetings in one place</span>
          </li>
          <li>
            <span className="welcome-pillar-icon">✦</span>
            <span>AI that reads your workspace, not the internet</span>
          </li>
        </ul>
        <p className="welcome-privacy-note">
          Everything is stored in a local database on this machine. Nothing is sent to any server.
        </p>
      </div>

      <div className="welcome-right">
        <div className="welcome-form-card">
          <h2>Let's set up your identity</h2>
          <p className="welcome-form-sub">
            Your name, title, and company are used to sign outgoing emails and personalise
            AI-generated content. You can change these any time in Settings.
          </p>

          <form className="welcome-form" onSubmit={handleSubmit} noValidate>
            <div className="welcome-field">
              <label htmlFor="wf-name">Your full name</label>
              <input
                id="wf-name"
                name="name"
                type="text"
                placeholder="Jane Smith"
                value={form.name}
                onChange={update}
                autoFocus
                autoComplete="name"
              />
            </div>

            <div className="welcome-field">
              <label htmlFor="wf-position">Your title</label>
              <input
                id="wf-position"
                name="position"
                type="text"
                placeholder="CEO"
                value={form.position}
                onChange={update}
                autoComplete="organization-title"
              />
            </div>

            <div className="welcome-field">
              <label htmlFor="wf-company">Company name</label>
              <input
                id="wf-company"
                name="company"
                type="text"
                placeholder="Acme Inc."
                value={form.company}
                onChange={update}
                autoComplete="organization"
              />
            </div>

            {error && <p className="status error">{error}</p>}

            <button
              type="submit"
              className="primary-button welcome-submit"
              disabled={!canSubmit || saving}
            >
              {saving ? "Saving…" : "Get started →"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
