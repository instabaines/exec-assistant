import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Stage = "lead" | "qualified" | "proposal" | "negotiation" | "won" | "lost";

type Deal = {
  id: number;
  title: string;
  company: string | null;
  contact_name: string | null;
  contact_email: string | null;
  value_text: string | null;
  stage: Stage;
  notes: string | null;
  next_action: string | null;
  next_action_date: string | null;
  created_at: string;
  updated_at: string;
};

const STAGES: Stage[] = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
const STAGE_LABEL: Record<Stage, string> = {
  lead: "Lead",
  qualified: "Qualified",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

const EMPTY_FORM = {
  title: "",
  company: "",
  contact_name: "",
  contact_email: "",
  value_text: "",
  stage: "lead" as Stage,
  notes: "",
  next_action: "",
  next_action_date: "",
};

export function DealPipeline() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await invoke<Deal[]>("list_deals");
      setDeals(result);
      if (selectedDeal) {
        const refreshed = result.find((d) => d.id === selectedDeal.id);
        if (refreshed) setSelectedDeal(refreshed);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function openNew() {
    setForm(EMPTY_FORM);
    setEditingId("new");
    setSelectedDeal(null);
  }

  function openEdit(deal: Deal) {
    setForm({
      title: deal.title,
      company: deal.company ?? "",
      contact_name: deal.contact_name ?? "",
      contact_email: deal.contact_email ?? "",
      value_text: deal.value_text ?? "",
      stage: deal.stage,
      notes: deal.notes ?? "",
      next_action: deal.next_action ?? "",
      next_action_date: deal.next_action_date ?? "",
    });
    setEditingId(deal.id);
    setSelectedDeal(deal);
  }

  async function saveDeal() {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        company: form.company.trim() || null,
        contact_name: form.contact_name.trim() || null,
        contact_email: form.contact_email.trim() || null,
        value_text: form.value_text.trim() || null,
        stage: form.stage,
        notes: form.notes.trim() || null,
        next_action: form.next_action.trim() || null,
        next_action_date: form.next_action_date || null,
      };
      if (editingId === "new") {
        await invoke("create_deal", { payload });
      } else {
        await invoke("update_deal", { payload: { id: editingId, ...payload } });
      }
      setEditingId(null);
      setSelectedDeal(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function moveStage(deal: Deal, stage: Stage) {
    await invoke("update_deal", { payload: { id: deal.id, stage } });
    setDeals((prev) => prev.map((d) => d.id === deal.id ? { ...d, stage } : d));
    if (selectedDeal?.id === deal.id) setSelectedDeal((d) => d ? { ...d, stage } : d);
  }

  async function deleteDeal(id: number) {
    if (!confirm("Delete this deal?")) return;
    await invoke("delete_deal", { id });
    setDeals((prev) => prev.filter((d) => d.id !== id));
    if (selectedDeal?.id === id) setSelectedDeal(null);
  }

  const byStage = (stage: Stage) => deals.filter((d) => d.stage === stage);
  const activeStages = STAGES.filter((s) => s !== "won" && s !== "lost");
  const closedStages: Stage[] = ["won", "lost"];

  return (
    <div className="feature-shell">
      <div className="feature-toolbar">
        <div className="pipeline-legend">
          {STAGES.map((s) => (
            <span key={s} className={`pipeline-legend-item stage-${s}`}>
              {STAGE_LABEL[s]} <strong>{byStage(s).length}</strong>
            </span>
          ))}
        </div>
        <button type="button" className="primary-button" onClick={openNew}>New deal</button>
      </div>

      {editingId !== null && (
        <div className="panel form-panel">
          <h3>{editingId === "new" ? "New deal" : "Edit deal"}</h3>
          <div className="form-grid three-col">
            <div className="mapping-row full-span">
              <label>Deal title</label>
              <input type="text" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Q3 Partnership — Acme Corp" autoFocus />
            </div>
            <div className="mapping-row">
              <label>Company</label>
              <input type="text" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} placeholder="Company name" />
            </div>
            <div className="mapping-row">
              <label>Contact</label>
              <input type="text" value={form.contact_name} onChange={(e) => setForm((f) => ({ ...f, contact_name: e.target.value }))} placeholder="Contact name" />
            </div>
            <div className="mapping-row">
              <label>Contact email</label>
              <input type="email" value={form.contact_email} onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))} placeholder="email@company.com" />
            </div>
            <div className="mapping-row">
              <label>Value</label>
              <input type="text" value={form.value_text} onChange={(e) => setForm((f) => ({ ...f, value_text: e.target.value }))} placeholder="e.g. $50,000 / yr" />
            </div>
            <div className="mapping-row">
              <label>Stage</label>
              <select value={form.stage} onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value as Stage }))}>
                {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
              </select>
            </div>
            <div className="mapping-row">
              <label>Next action</label>
              <input type="text" value={form.next_action} onChange={(e) => setForm((f) => ({ ...f, next_action: e.target.value }))} placeholder="e.g. Send proposal" />
            </div>
            <div className="mapping-row">
              <label>Action date</label>
              <input type="date" value={form.next_action_date} onChange={(e) => setForm((f) => ({ ...f, next_action_date: e.target.value }))} />
            </div>
            <div className="mapping-row full-span">
              <label>Notes</label>
              <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Deal context, history, or key details" rows={2} />
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="primary-button" onClick={saveDeal} disabled={saving || !form.title.trim()}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty-state"><p>Loading pipeline…</p></div>
      ) : (
        <>
          <div className="pipeline-board">
            {activeStages.map((stage) => (
              <div key={stage} className={`pipeline-column stage-col-${stage}`}>
                <div className="pipeline-column-header">
                  <span className={`stage-label stage-${stage}`}>{STAGE_LABEL[stage]}</span>
                  <span className="pipeline-count">{byStage(stage).length}</span>
                </div>
                {byStage(stage).length === 0 ? (
                  <div className="pipeline-empty">No deals here</div>
                ) : (
                  byStage(stage).map((deal) => (
                    <DealCard key={deal.id} deal={deal} onEdit={openEdit} onMove={moveStage} onDelete={deleteDeal} />
                  ))
                )}
              </div>
            ))}
          </div>

          <div className="pipeline-closed-row">
            {closedStages.map((stage) => (
              <div key={stage} className={`pipeline-closed-section stage-col-${stage}`}>
                <div className="pipeline-column-header">
                  <span className={`stage-label stage-${stage}`}>{STAGE_LABEL[stage]}</span>
                  <span className="pipeline-count">{byStage(stage).length}</span>
                </div>
                {byStage(stage).map((deal) => (
                  <DealCard key={deal.id} deal={deal} onEdit={openEdit} onMove={moveStage} onDelete={deleteDeal} compact />
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function daysStale(updatedAt: string): number {
  const t = new Date(updatedAt.includes("T") ? updatedAt : updatedAt.replace(" ", "T") + "Z");
  return Math.floor((Date.now() - t.getTime()) / 86400000);
}

function isOverdueDate(dateStr: string | null): boolean {
  if (!dateStr) return false;
  return dateStr < new Date().toISOString().slice(0, 10);
}

function DealCard({
  deal,
  onEdit,
  onMove,
  onDelete,
  compact = false,
}: {
  deal: Deal;
  onEdit: (d: Deal) => void;
  onMove: (d: Deal, s: Stage) => void;
  onDelete: (id: number) => void;
  compact?: boolean;
}) {
  const stale = daysStale(deal.updated_at);
  const isStale = stale >= 7 && deal.stage !== "won" && deal.stage !== "lost";
  const actionOverdue = isOverdueDate(deal.next_action_date);

  return (
    <div className={`deal-card${compact ? " compact" : ""}${isStale ? " deal-stale" : ""}`}>
      <div className="deal-card-title">
        {deal.title}
        {isStale && <span className="stale-badge" title={`No activity for ${stale} days`}>{stale}d</span>}
      </div>
      {deal.company && <div className="deal-card-company">{deal.company}</div>}
      {!compact && (
        <>
          {deal.contact_name && <div className="deal-card-contact">{deal.contact_name}</div>}
          {deal.value_text && <div className="deal-card-value">{deal.value_text}</div>}
          {deal.next_action && (
            <div className={`deal-card-action${actionOverdue ? " action-overdue" : ""}`}>
              <span>→ {deal.next_action}</span>
              {deal.next_action_date && (
                <span className={`deal-card-date${actionOverdue ? " overdue-date" : ""}`}>
                  {actionOverdue ? "Overdue · " : ""}{deal.next_action_date}
                </span>
              )}
            </div>
          )}
        </>
      )}
      <div className="deal-card-footer">
        <select
          value={deal.stage}
          onChange={(e) => onMove(deal, e.target.value as Stage)}
          className="deal-stage-select"
          onClick={(e) => e.stopPropagation()}
        >
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        <button type="button" className="icon-button" onClick={() => onEdit(deal)}>Edit</button>
        <button type="button" className="icon-button destructive" onClick={() => onDelete(deal.id)}>✕</button>
      </div>
    </div>
  );
}
