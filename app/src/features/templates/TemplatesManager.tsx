import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type TemplateRecord = {
  id: number;
  name: string;
  industry: string;
  tone: string;
  subject_template: string;
  body_template: string;
  system_prompt: string;
  version: number;
  active: boolean;
};

type GenerationSettings = {
  default_system_prompt: string;
  sender_name: string;
  sender_position: string;
  sender_company: string;
};

type TemplateEditor = {
  id?: number;
  name: string;
  industry: string;
  tone: string;
  subject_template: string;
  body_template: string;
  system_prompt: string;
  active: boolean;
};

const EMPTY_TEMPLATE: TemplateEditor = {
  name: "",
  industry: "",
  tone: "Warm and professional",
  subject_template: "",
  body_template: "",
  system_prompt: "",
  active: true,
};

const PREVIEW_CLIENT = {
  name: "Jordan Lee",
  company: "Northwind Health",
  industry: "Healthcare",
};

function renderPreviewValue(
  template: string,
  values: {
    name: string;
    company: string;
    industry: string;
    sender_name: string;
    sender_position: string;
    sender_company: string;
  },
) {
  return template
    .replace(/{{name}}/g, values.name)
    .replace(/{{company}}/g, values.company)
    .replace(/{{industry}}/g, values.industry)
    .replace(/{{sender_name}}/g, values.sender_name)
    .replace(/{{ sender_name }}/g, values.sender_name)
    .replace(/{{sender_position}}/g, values.sender_position)
    .replace(/{{ sender_position }}/g, values.sender_position)
    .replace(/{{sender_company}}/g, values.sender_company)
    .replace(/{{ sender_company }}/g, values.sender_company);
}

export function TemplatesManager() {
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editor, setEditor] = useState<TemplateEditor>(EMPTY_TEMPLATE);
  const [status, setStatus] = useState("Loading message rules...");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<GenerationSettings>({
    default_system_prompt: "",
    sender_name: "",
    sender_position: "",
    sender_company: "",
  });
  const [settingsStatus, setSettingsStatus] = useState("This writing guidance stays on this device.");
  const [generateIndustry, setGenerateIndustry] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateStatus, setGenerateStatus] = useState("");

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedId) ?? null,
    [selectedId, templates],
  );

  const previewValues = useMemo(
    () => ({
      ...PREVIEW_CLIENT,
      sender_name: settings.sender_name || "Your Name",
      sender_position: settings.sender_position || "Your Title",
      sender_company: settings.sender_company || "Your Company",
    }),
    [settings.sender_company, settings.sender_name, settings.sender_position],
  );

  const subjectPreview = useMemo(
    () =>
      renderPreviewValue(
        editor.subject_template || "Your subject will appear here.",
        previewValues,
      ),
    [editor.subject_template, previewValues],
  );

  const bodyPreview = useMemo(
    () =>
      renderPreviewValue(
        editor.body_template || "Your message preview will appear here once you start writing a template.",
        previewValues,
      ),
    [editor.body_template, previewValues],
  );

  async function refreshTemplates() {
    setLoading(true);
    setStatus("Loading message rules...");
    try {
      await invoke<number>("seed_default_templates");
      const [list, fetchedSettings] = await Promise.all([
        invoke<TemplateRecord[]>("list_templates"),
        invoke<GenerationSettings>("get_generation_settings"),
      ]);

      setTemplates(list);
      setSettings(fetchedSettings);
      setStatus(list.length > 0 ? `${list.length} message rules available.` : "Create your first message rule.");

      if (selectedId === null && list.length > 0) {
        setSelectedId(list[0].id);
      }
    } catch (error) {
      setStatus(`Could not load message rules: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshTemplates();
  }, []);

  useEffect(() => {
    if (!selectedTemplate) {
      setEditor(EMPTY_TEMPLATE);
      return;
    }

    setEditor({
      id: selectedTemplate.id,
      name: selectedTemplate.name,
      industry: selectedTemplate.industry,
      tone: selectedTemplate.tone,
      subject_template: selectedTemplate.subject_template,
      body_template: selectedTemplate.body_template,
      system_prompt: selectedTemplate.system_prompt,
      active: selectedTemplate.active,
    });
  }, [selectedTemplate]);

  async function saveTemplate() {
    if (!editor.name.trim() || !editor.industry.trim() || !editor.subject_template.trim() || !editor.body_template.trim()) {
      setStatus("Name, industry, subject, and body are required.");
      return;
    }

    setSaving(true);
    setStatus("Saving message rule...");
    try {
      const result = await invoke<{ id: number; version: number }>("upsert_template", {
        payload: editor,
      });
      setSelectedId(result.id);
      setStatus(`Message rule saved (version ${result.version}).`);
      await refreshTemplates();
    } catch (error) {
      setStatus(`Could not save message rule: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function generateRule() {
    if (!generateIndustry.trim()) return;
    setGenerating(true);
    setGenerateStatus("Generating rule…");
    setSelectedId(null);
    setEditor(EMPTY_TEMPLATE);
    try {
      const current = await invoke<{ model: string }>("get_generation_settings");
      const result = await invoke<{
        name: string;
        tone: string;
        subject_template: string;
        body_template: string;
        system_prompt: string;
      }>("ai_generate_rule", { model: current.model, industry: generateIndustry.trim() });
      setEditor({
        name: result.name || `${generateIndustry} Outreach`,
        industry: generateIndustry.trim(),
        tone: result.tone || "Professional",
        subject_template: result.subject_template,
        body_template: result.body_template,
        system_prompt: result.system_prompt,
        active: true,
      });
      setGenerateStatus("Rule generated — review it below and save when ready.");
    } catch (e) {
      setGenerateStatus(`Generation failed: ${String(e)}`);
    } finally {
      setGenerating(false);
    }
  }

  async function saveSettings() {
    setSettingsStatus("Saving writing guidance...");
    try {
      const current = await invoke<{
        model: string;
        default_system_prompt: string;
        sender_name: string;
        sender_position: string;
        sender_company: string;
      }>("get_generation_settings");
      await invoke("set_generation_settings", {
        payload: {
          model: current.model,
          default_system_prompt: settings.default_system_prompt,
          sender_name: settings.sender_name,
          sender_position: settings.sender_position,
          sender_company: settings.sender_company,
        },
      });
      setSettingsStatus("Writing guidance saved.");
    } catch (error) {
      setSettingsStatus(`Could not save writing guidance: ${String(error)}`);
    }
  }

  return (
    <>
      <div className="panel hero-panel">
        <div className="panel-header">
          <div>
            <div className="eyebrow">Brand & Sender</div>
            <h2>Set who the outreach comes from</h2>
          </div>
          <div className="panel-chip">{templates.length} active rules</div>
        </div>
        <p>
          Use this area to keep sender details, tone, and message patterns consistent. Think of it as the approved voice of the business.
        </p>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Shared writing guidance</h2>
            <p>Set the sender identity and the core writing guidance that should apply across every outreach round.</p>
          </div>
        </div>
        <div className="form-grid two-col">
          <label className="mapping-row">
            <span>Sender name</span>
            <input
              value={settings.sender_name}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  sender_name: event.target.value,
                }))
              }
              placeholder="Example: Amina Yusuf"
            />
          </label>
          <label className="mapping-row">
            <span>Sender position</span>
            <input
              value={settings.sender_position}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  sender_position: event.target.value,
                }))
              }
              placeholder="Example: Client Success Director"
            />
          </label>
          <label className="mapping-row full-span">
            <span>Sender company</span>
            <input
              value={settings.sender_company}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  sender_company: event.target.value,
                }))
              }
              placeholder="Example: Northstar Advisory"
            />
          </label>
          <label className="mapping-row">
            <span>Business writing guidance</span>
            <textarea
              value={settings.default_system_prompt}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  default_system_prompt: event.target.value,
                }))
              }
              rows={5}
            />
          </label>
        </div>
        <div className="panel-actions">
          <button type="button" className="primary-button" onClick={saveSettings}>
            Save guidance
          </button>
        </div>
        <div className="notice-card calm">
          <strong>Sender preview</strong>
          <p>
            Messages will sign off as <span className="sender-preview-name">{previewValues.sender_name}</span>, {previewValues.sender_position} at {previewValues.sender_company}.
          </p>
        </div>
        <p className="status idle">{settingsStatus}</p>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Rule library</h2>
            <p>Keep a small, high-quality library of approved message patterns by industry or use case.</p>
          </div>
        </div>
        <div className="template-list">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className={selectedId === template.id ? "nav-card inline active" : "nav-card inline"}
              onClick={() => setSelectedId(template.id)}
            >
              <span>{template.name}</span>
              <small>{template.industry}</small>
            </button>
          ))}
          <button
            type="button"
            className="nav-card inline"
            onClick={() => {
              setSelectedId(null);
              setEditor(EMPTY_TEMPLATE);
            }}
          >
            <span>New rule</span>
            <small>Write from scratch</small>
          </button>
        </div>

        <div className="rule-generate-bar">
          <div className="rule-generate-inputs">
            <input
              type="text"
              value={generateIndustry}
              onChange={(e) => setGenerateIndustry(e.target.value)}
              placeholder="Industry — e.g. Hospitality, SaaS, Logistics…"
              onKeyDown={(e) => e.key === "Enter" && generateRule()}
              disabled={generating}
            />
            <button
              type="button"
              className="primary-button"
              onClick={generateRule}
              disabled={generating || !generateIndustry.trim()}
            >
              {generating ? "Generating…" : "Generate rule with AI"}
            </button>
          </div>
          {generateStatus && (
            <p className={`rule-generate-status${generateStatus.includes("failed") ? " error" : ""}`}>
              {generateStatus}
            </p>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>{editor.id ? `Edit pattern #${editor.id}` : "New message pattern"}</h2>
            <p>Keep variables like <code>{'{{name}}'}</code>, <code>{'{{company}}'}</code>, <code>{'{{sender_name}}'}</code>, and <code>{'{{sender_position}}'}</code> where personalization is needed.</p>
          </div>
          <div className={editor.active ? "panel-chip success" : "panel-chip"}>{editor.active ? "Active" : "Paused"}</div>
        </div>

        <div className="form-grid two-col">
          <label className="mapping-row">
            <span>Rule name *</span>
            <input value={editor.name} onChange={(event) => setEditor((prev) => ({ ...prev, name: event.target.value }))} />
          </label>
          <label className="mapping-row">
            <span>Industry *</span>
            <input
              value={editor.industry}
              onChange={(event) => setEditor((prev) => ({ ...prev, industry: event.target.value }))}
            />
          </label>
          <label className="mapping-row">
            <span>Tone</span>
            <input value={editor.tone} onChange={(event) => setEditor((prev) => ({ ...prev, tone: event.target.value }))} />
          </label>
          <label className="inline-checkbox">
            <input
              type="checkbox"
              checked={editor.active}
              onChange={(event) => setEditor((prev) => ({ ...prev, active: event.target.checked }))}
            />
            Keep this rule available during drafting
          </label>
          <label className="mapping-row">
            <span>Subject pattern *</span>
            <input
              value={editor.subject_template}
              onChange={(event) => setEditor((prev) => ({ ...prev, subject_template: event.target.value }))}
            />
          </label>
          <label className="mapping-row full-span">
            <span>Message pattern *</span>
            <textarea
              value={editor.body_template}
              onChange={(event) => setEditor((prev) => ({ ...prev, body_template: event.target.value }))}
              rows={8}
            />
          </label>
          <label className="mapping-row full-span">
            <span>Advanced assistant guidance</span>
            <textarea
              value={editor.system_prompt}
              onChange={(event) => setEditor((prev) => ({ ...prev, system_prompt: event.target.value }))}
              rows={5}
            />
          </label>
        </div>

        <div className="panel-actions">
          <button type="button" className="primary-button" onClick={saveTemplate} disabled={saving || loading}>
            {saving ? "Saving..." : "Save message rule"}
          </button>
          <button type="button" className="secondary-button" onClick={refreshTemplates} disabled={loading}>
            Refresh
          </button>
        </div>
        <p className="status idle">{status}</p>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Live placeholder preview</h2>
            <p>
              This example uses <strong>{previewValues.name}</strong> at <strong>{previewValues.company}</strong> in the{" "}
              {previewValues.industry} industry so you can see how sender and client placeholders resolve.
            </p>
          </div>
        </div>
        <div className="form-grid">
          <label className="mapping-row">
            <span>Subject preview</span>
            <div className="template-body">{subjectPreview}</div>
          </label>
          <label className="mapping-row">
            <span>Message preview</span>
            <div className="template-body">{bodyPreview}</div>
          </label>
        </div>
      </div>
    </>
  );
}
