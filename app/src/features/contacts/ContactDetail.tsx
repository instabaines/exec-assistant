import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ContactEmail = {
  campaign_name: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
};

type ContactDeal = {
  id: number;
  title: string;
  stage: string;
  value_text: string | null;
  next_action: string | null;
  next_action_date: string | null;
};

type ContactTask = {
  id: number;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
};

type ContactMeeting = {
  id: number;
  title: string;
  meeting_date: string | null;
  summary: string | null;
};

type ContactProfile = {
  id: number;
  name: string;
  email: string;
  company: string;
  industry: string;
  notes: string | null;
  last_contacted_at: string;
  emails: ContactEmail[];
  deals: ContactDeal[];
  tasks: ContactTask[];
  meetings: ContactMeeting[];
};

const STAGE_LABEL: Record<string, string> = {
  lead: "Lead", qualified: "Qualified", proposal: "Proposal",
  negotiation: "Negotiation", won: "Won", lost: "Lost",
};

const STATUS_COLOR: Record<string, string> = {
  approved: "success", sent: "success", review_required: "warn",
  refine_requested: "warn", done: "success", in_progress: "active",
};

type Props = {
  clientId: number;
  onBack: () => void;
};

export function ContactDetail({ clientId, onBack }: Props) {
  const [profile, setProfile] = useState<ContactProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedEmailId, setExpandedEmailId] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    invoke<ContactProfile>("get_contact_profile", { clientId })
      .then(setProfile)
      .finally(() => setLoading(false));
  }, [clientId]);

  if (loading) return <div className="contact360-loading">Loading contact profile…</div>;
  if (!profile) return <div className="contact360-loading">Contact not found.</div>;

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="contact360-shell">
      <button type="button" className="contact360-back" onClick={onBack}>
        ← Back to contacts
      </button>

      {/* Header */}
      <div className="contact360-header">
        <div className="contact360-avatar">
          {profile.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
        </div>
        <div className="contact360-identity">
          <h2>{profile.name}</h2>
          <div className="contact360-meta">
            {profile.company && <span>{profile.company}</span>}
            {profile.industry && <span className="contact360-industry">{profile.industry}</span>}
            <a href={`mailto:${profile.email}`} className="contact360-email">{profile.email}</a>
          </div>
          {profile.last_contacted_at && (
            <div className="contact360-last">Last contacted: {profile.last_contacted_at}</div>
          )}
        </div>
        <div className="contact360-stat-row">
          <div className="contact360-stat">
            <strong>{profile.emails.length}</strong>
            <span>emails</span>
          </div>
          <div className="contact360-stat">
            <strong>{profile.deals.length}</strong>
            <span>deals</span>
          </div>
          <div className="contact360-stat">
            <strong>{profile.tasks.length}</strong>
            <span>tasks</span>
          </div>
        </div>
      </div>

      <div className="contact360-body">
        {/* Deals */}
        {profile.deals.length > 0 && (
          <section className="contact360-section">
            <h3 className="contact360-section-title">Pipeline</h3>
            {profile.deals.map((d) => (
              <div key={d.id} className={`contact360-deal-card stage-${d.stage}`}>
                <div className="contact360-deal-header">
                  <span className="contact360-deal-title">{d.title}</span>
                  <span className={`stage-label stage-${d.stage}`}>{STAGE_LABEL[d.stage] ?? d.stage}</span>
                </div>
                {d.value_text && <div className="contact360-deal-value">{d.value_text}</div>}
                {d.next_action && (
                  <div className={`contact360-deal-action${d.next_action_date && d.next_action_date < today ? " overdue" : ""}`}>
                    → {d.next_action}
                    {d.next_action_date && <span className="contact360-deal-date">{d.next_action_date < today ? "Overdue · " : ""}{d.next_action_date}</span>}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {/* Tasks */}
        {profile.tasks.length > 0 && (
          <section className="contact360-section">
            <h3 className="contact360-section-title">Related tasks</h3>
            <div className="contact360-task-list">
              {profile.tasks.map((t) => (
                <div key={t.id} className={`contact360-task priority-${t.priority}${t.due_date && t.due_date < today && t.status !== "done" ? " overdue-task" : ""}`}>
                  <div className="contact360-task-header">
                    <span className={`mini-pill ${STATUS_COLOR[t.status] ?? ""}`}>{t.status.replace("_", " ")}</span>
                    <span className={`priority-badge priority-${t.priority}`}>{t.priority}</span>
                    {t.due_date && <span className={`task-due${t.due_date < today && t.status !== "done" ? " task-due-overdue" : ""}`}>{t.due_date}</span>}
                  </div>
                  <div className="contact360-task-title">{t.title}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Meetings */}
        {profile.meetings.length > 0 && (
          <section className="contact360-section">
            <h3 className="contact360-section-title">Meeting mentions</h3>
            {profile.meetings.map((m) => (
              <div key={m.id} className="contact360-meeting-card">
                <div className="contact360-meeting-header">
                  <span className="contact360-meeting-title">{m.title}</span>
                  {m.meeting_date && <span className="contact360-meeting-date">{m.meeting_date}</span>}
                </div>
                {m.summary && <p className="contact360-meeting-summary">{m.summary}</p>}
              </div>
            ))}
          </section>
        )}

        {/* Notes */}
        <section className="contact360-section">
          <h3 className="contact360-section-title">Notes</h3>
          <p className="contact360-notes">{profile.notes || "No notes yet."}</p>
        </section>

        {/* Email history */}
        <section className="contact360-section">
          <h3 className="contact360-section-title">Email history ({profile.emails.length})</h3>
          {profile.emails.length === 0 ? (
            <p className="contact360-empty">No emails sent to this contact yet.</p>
          ) : (
            <div className="contact360-email-list">
              {profile.emails.map((e, i) => (
                <div key={i} className="contact360-email-item">
                  <button
                    type="button"
                    className="contact360-email-header"
                    onClick={() => setExpandedEmailId(expandedEmailId === i ? null : i)}
                  >
                    <div className="contact360-email-top">
                      <span className="contact360-email-subject">{e.subject || "(no subject)"}</span>
                      <span className={`mini-pill ${STATUS_COLOR[e.status] ?? ""}`}>{e.status.replace("_", " ")}</span>
                    </div>
                    <div className="contact360-email-bottom">
                      <span className="contact360-email-campaign">{e.campaign_name}</span>
                      <span className="contact360-email-date">{e.created_at.slice(0, 10)}</span>
                      <span className="contact360-email-chevron">{expandedEmailId === i ? "▲" : "▼"}</span>
                    </div>
                  </button>
                  {expandedEmailId === i && (
                    <pre className="contact360-email-body">{e.body}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
