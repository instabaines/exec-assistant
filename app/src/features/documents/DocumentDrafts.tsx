import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type DocStatus = "draft" | "final";
type DocType = "proposal" | "report" | "memo" | "deck_outline";

type Document = {
  id: number;
  title: string;
  doc_type: DocType;
  brief: string | null;
  content: string | null;
  status: DocStatus;
  created_at: string;
  updated_at: string;
};

const DOC_TYPE_LABEL: Record<DocType, string> = {
  proposal: "Proposal",
  report: "Report",
  memo: "Memo",
  deck_outline: "Deck outline",
};

type Props = { model: string };

export function DocumentDrafts({ model }: Props) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selected, setSelected] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newForm, setNewForm] = useState({ title: "", doc_type: "proposal" as DocType });
  const [editBrief, setEditBrief] = useState("");
  const [editContent, setEditContent] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await invoke<Document[]>("list_documents");
      setDocuments(result);
      if (selected) {
        const refreshed = result.find((d) => d.id === selected.id);
        if (refreshed) setSelected(refreshed);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (selected) {
      setEditBrief(selected.brief ?? "");
      setEditContent(selected.content ?? "");
    }
  }, [selected?.id]);

  async function createDocument() {
    if (!newForm.title.trim()) return;
    const doc = await invoke<Document>("create_document", {
      payload: { title: newForm.title.trim(), doc_type: newForm.doc_type },
    });
    setDocuments((prev) => [doc, ...prev]);
    setSelected(doc);
    setEditBrief("");
    setEditContent("");
    setCreatingNew(false);
    setNewForm({ title: "", doc_type: "proposal" });
  }

  async function saveBrief() {
    if (!selected) return;
    setSaving(true);
    try {
      const updated = await invoke<Document>("update_document", {
        payload: { id: selected.id, brief: editBrief },
      });
      setSelected(updated);
      setDocuments((prev) => prev.map((d) => d.id === updated.id ? updated : d));
    } finally {
      setSaving(false);
    }
  }

  async function saveContent() {
    if (!selected) return;
    setSaving(true);
    try {
      const updated = await invoke<Document>("update_document", {
        payload: { id: selected.id, content: editContent },
      });
      setSelected(updated);
      setDocuments((prev) => prev.map((d) => d.id === updated.id ? updated : d));
    } finally {
      setSaving(false);
    }
  }

  async function markFinal() {
    if (!selected) return;
    const updated = await invoke<Document>("update_document", {
      payload: { id: selected.id, status: "final" },
    });
    setSelected(updated);
    setDocuments((prev) => prev.map((d) => d.id === updated.id ? updated : d));
  }

  async function aiDraft() {
    if (!selected) return;
    setDrafting(true);
    try {
      // Save current brief first
      await invoke<Document>("update_document", { payload: { id: selected.id, brief: editBrief } });
      const result = await invoke<Document>("ai_draft_document", { id: selected.id, model });
      setSelected(result);
      setEditContent(result.content ?? "");
      setDocuments((prev) => prev.map((d) => d.id === result.id ? result : d));
    } catch (err) {
      alert(String(err));
    } finally {
      setDrafting(false);
    }
  }

  async function deleteDocument(id: number) {
    if (!confirm("Delete this document?")) return;
    await invoke("delete_document", { id });
    setDocuments((prev) => prev.filter((d) => d.id !== id));
    if (selected?.id === id) setSelected(null);
  }

  return (
    <div className="split-layout">
      <aside className="split-sidebar">
        <div className="split-sidebar-header">
          <h3>Documents</h3>
          <button type="button" className="primary-button compact" onClick={() => setCreatingNew(true)}>New</button>
        </div>

        {creatingNew && (
          <div className="split-new-form">
            <input
              type="text"
              placeholder="Document title"
              value={newForm.title}
              onChange={(e) => setNewForm((f) => ({ ...f, title: e.target.value }))}
              autoFocus
            />
            <select value={newForm.doc_type} onChange={(e) => setNewForm((f) => ({ ...f, doc_type: e.target.value as DocType }))}>
              {(Object.keys(DOC_TYPE_LABEL) as DocType[]).map((t) => (
                <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>
              ))}
            </select>
            <div className="split-new-form-actions">
              <button type="button" className="primary-button compact" onClick={createDocument} disabled={!newForm.title.trim()}>Create</button>
              <button type="button" className="secondary-button compact" onClick={() => setCreatingNew(false)}>Cancel</button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="split-sidebar-empty">Loading…</p>
        ) : documents.length === 0 ? (
          <p className="split-sidebar-empty">No documents yet.</p>
        ) : (
          <div className="split-item-list">
            {documents.map((doc) => (
              <button
                key={doc.id}
                type="button"
                className={selected?.id === doc.id ? "split-item active" : "split-item"}
                onClick={() => setSelected(doc)}
              >
                <span className="split-item-title">{doc.title}</span>
                <div className="split-item-badges">
                  <span className="split-item-meta">{DOC_TYPE_LABEL[doc.doc_type]}</span>
                  {doc.status === "final" && <span className="split-item-tag">Final</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </aside>

      <div className="split-content">
        {!selected ? (
          <div className="empty-state centered">
            <h3>Select a document</h3>
            <p>Choose an existing document or create a new one.</p>
          </div>
        ) : (
          <>
            <div className="split-content-header">
              <div>
                <h2>{selected.title}</h2>
                <div className="split-content-meta">
                  <span>{DOC_TYPE_LABEL[selected.doc_type]}</span>
                  <span className={selected.status === "final" ? "status-badge final" : "status-badge draft"}>
                    {selected.status === "final" ? "Final" : "Draft"}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {selected.status !== "final" && (
                  <button type="button" className="secondary-button" onClick={markFinal}>Mark final</button>
                )}
                <button type="button" className="icon-button destructive" onClick={() => deleteDocument(selected.id)}>Delete</button>
              </div>
            </div>

            <div className="doc-brief-area">
              <label className="section-label">Brief</label>
              <textarea
                className="notes-textarea"
                value={editBrief}
                onChange={(e) => setEditBrief(e.target.value)}
                placeholder="Describe what this document should cover — audience, purpose, key points to include…"
                rows={4}
              />
              <div className="doc-brief-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={aiDraft}
                  disabled={drafting || !editBrief.trim()}
                >
                  {drafting ? "Drafting…" : selected.content ? "Redraft with AI" : "Draft with AI"}
                </button>
                <button type="button" className="secondary-button" onClick={saveBrief} disabled={saving}>
                  Save brief
                </button>
              </div>
            </div>

            {(editContent || selected.content) && (
              <div className="doc-content-area">
                <label className="section-label">Content</label>
                <textarea
                  className="notes-textarea doc-content-textarea"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={20}
                />
                <div className="doc-brief-actions">
                  <button type="button" className="primary-button" onClick={saveContent} disabled={saving}>
                    {saving ? "Saving…" : "Save content"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
