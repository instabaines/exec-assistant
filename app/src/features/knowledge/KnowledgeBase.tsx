import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type DocType = "company" | "campaign" | "contact";

type KnowledgeDocument = {
  id: number;
  name: string;
  doc_type: DocType;
  campaign_id: number | null;
  contact_id: number | null;
  content: string;
  created_at: string;
};

const TYPE_LABEL: Record<DocType, string> = {
  company: "Company profile",
  campaign: "Campaign brief",
  contact: "Contact note",
};

const TYPE_DESC: Record<DocType, string> = {
  company: "Always available to the AI. Describe your offering, value props, differentiators.",
  campaign: "Attached to a specific campaign. The AI uses it as the primary source for that round.",
  contact: "Attached to a specific contact. Injected when drafting that person's email.",
};

type Props = {
  campaignId?: number | null;
  contactId?: number | null;
  compact?: boolean;
};

export function KnowledgeBase({ campaignId, contactId, compact = false }: Props) {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", doc_type: "company" as DocType, content: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await invoke<KnowledgeDocument[]>("list_knowledge_docs", {
        docType: null,
      });
      setDocs(result);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function openNew(defaultType: DocType = "company") {
    setForm({ name: "", doc_type: defaultType, content: "" });
    setCreating(true);
    setEditingId(null);
  }

  function openEdit(doc: KnowledgeDocument) {
    setForm({ name: doc.name, doc_type: doc.doc_type, content: doc.content });
    setEditingId(doc.id);
    setCreating(false);
  }

  async function save() {
    if (!form.name.trim() || !form.content.trim()) return;
    setSaving(true);
    try {
      if (editingId !== null) {
        await invoke("update_knowledge_doc_content", { id: editingId, content: form.content });
      } else {
        await invoke("save_knowledge_doc", {
          payload: {
            name: form.name.trim(),
            doc_type: form.doc_type,
            campaign_id: form.doc_type === "campaign" ? (campaignId ?? null) : null,
            contact_id: form.doc_type === "contact" ? (contactId ?? null) : null,
            content: form.content.trim(),
          },
        });
      }
      setCreating(false);
      setEditingId(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function deleteDoc(id: number) {
    if (!confirm("Remove this document from the knowledge base?")) return;
    await invoke("delete_knowledge_doc", { id });
    setDocs((prev) => prev.filter((d) => d.id !== id));
  }

  const visibleDocs = compact
    ? docs.filter(
        (d) =>
          d.doc_type === "company" ||
          (d.doc_type === "campaign" && d.campaign_id === campaignId) ||
          (d.doc_type === "contact" && d.contact_id === contactId)
      )
    : docs;

  return (
    <div className="knowledge-base">
      <div className="knowledge-header">
        <div>
          <h3>Knowledge base</h3>
          <p>
            Documents here are automatically injected into AI generation.{" "}
            <strong>Company profile</strong> is always included.{" "}
            Campaign briefs and contact notes are injected when relevant.
          </p>
        </div>
        <div className="knowledge-add-buttons">
          <button type="button" className="secondary-button compact" onClick={() => openNew("company")}>+ Company profile</button>
          {campaignId && <button type="button" className="secondary-button compact" onClick={() => openNew("campaign")}>+ Campaign brief</button>}
          {contactId && <button type="button" className="secondary-button compact" onClick={() => openNew("contact")}>+ Contact note</button>}
          {!campaignId && !contactId && (
            <>
              <button type="button" className="secondary-button compact" onClick={() => openNew("campaign")}>+ Campaign brief</button>
              <button type="button" className="secondary-button compact" onClick={() => openNew("contact")}>+ Contact note</button>
            </>
          )}
        </div>
      </div>

      {(creating || editingId !== null) && (
        <div className="knowledge-form">
          {!editingId && (
            <div className="form-grid two-col">
              <div className="mapping-row">
                <label>Document name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Q3 2025 Offering Overview"
                  autoFocus
                />
              </div>
              <div className="mapping-row">
                <label>Type</label>
                <select value={form.doc_type} onChange={(e) => setForm((f) => ({ ...f, doc_type: e.target.value as DocType }))}>
                  <option value="company">Company profile (always used)</option>
                  <option value="campaign">Campaign brief (per campaign)</option>
                  <option value="contact">Contact note (per recipient)</option>
                </select>
              </div>
            </div>
          )}
          <div className="knowledge-type-hint">
            {TYPE_DESC[form.doc_type]}
          </div>
          <div className="mapping-row">
            <label>Content</label>
            <textarea
              className="notes-textarea knowledge-textarea"
              value={form.content}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              placeholder={
                form.doc_type === "company"
                  ? "Describe your company — what you offer, who you serve, your key differentiators, current promotions…"
                  : form.doc_type === "campaign"
                  ? "Describe this campaign — the specific offering, pricing, target audience, unique angle…"
                  : "Notes about this specific contact — their priorities, past interactions, what they care about…"
              }
              rows={8}
            />
          </div>
          <div className="form-actions">
            <button type="button" className="primary-button" onClick={save} disabled={saving || !form.name.trim() || !form.content.trim()}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Add to knowledge base"}
            </button>
            <button type="button" className="secondary-button" onClick={() => { setCreating(false); setEditingId(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="knowledge-empty">Loading…</p>
      ) : visibleDocs.length === 0 ? (
        <p className="knowledge-empty">
          No documents yet. Add a company profile so the AI knows what to write about.
        </p>
      ) : (
        <div className="knowledge-doc-list">
          {visibleDocs.map((doc) => (
            <div key={doc.id} className={`knowledge-doc-card type-${doc.doc_type}`}>
              <div className="knowledge-doc-meta">
                <span className={`knowledge-type-badge type-${doc.doc_type}`}>
                  {TYPE_LABEL[doc.doc_type]}
                </span>
                <span className="knowledge-doc-name">{doc.name}</span>
              </div>
              <p className="knowledge-doc-preview">
                {doc.content.length > 180 ? `${doc.content.slice(0, 180)}…` : doc.content}
              </p>
              <div className="knowledge-doc-actions">
                <button type="button" className="icon-button" onClick={() => openEdit(doc)}>Edit</button>
                <button type="button" className="icon-button destructive" onClick={() => deleteDoc(doc.id)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
