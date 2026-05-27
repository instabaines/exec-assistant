import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Meeting = {
  id: number;
  title: string;
  meeting_date: string | null;
  attendees: string | null;
  raw_notes: string | null;
  summary: string | null;
  action_items_json: string | null;
  created_at: string;
  updated_at: string;
};

type MeetingSummaryResult = {
  id: number;
  summary: string;
  action_items_json: string;
};

type Props = { model: string };

export function MeetingNotes({ model }: Props) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newForm, setNewForm] = useState({ title: "", meeting_date: "", attendees: "" });
  const [editNotes, setEditNotes] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [taskCreating, setTaskCreating] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const result = await invoke<Meeting[]>("list_meetings");
      setMeetings(result);
      if (selected) {
        const refreshed = result.find((m) => m.id === selected.id);
        if (refreshed) setSelected(refreshed);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (selected) setEditNotes(selected.raw_notes ?? "");
  }, [selected?.id]);

  async function createMeeting() {
    if (!newForm.title.trim()) return;
    const meeting = await invoke<Meeting>("create_meeting", {
      payload: {
        title: newForm.title.trim(),
        meeting_date: newForm.meeting_date || null,
        attendees: newForm.attendees.trim() || null,
        raw_notes: null,
      },
    });
    setMeetings((prev) => [meeting, ...prev]);
    setSelected(meeting);
    setEditNotes("");
    setCreatingNew(false);
    setNewForm({ title: "", meeting_date: "", attendees: "" });
  }

  async function saveNotes() {
    if (!selected) return;
    setSavingNotes(true);
    try {
      const updated = await invoke<Meeting>("update_meeting", {
        payload: { id: selected.id, raw_notes: editNotes },
      });
      setSelected(updated);
      setMeetings((prev) => prev.map((m) => m.id === updated.id ? updated : m));
    } finally {
      setSavingNotes(false);
    }
  }

  async function summarize() {
    if (!selected) return;
    setSummarizing(true);
    try {
      const result = await invoke<MeetingSummaryResult>("ai_summarize_meeting", {
        id: selected.id,
        model,
      });
      const updated: Meeting = {
        ...selected,
        summary: result.summary,
        action_items_json: result.action_items_json,
      };
      setSelected(updated);
      setMeetings((prev) => prev.map((m) => m.id === updated.id ? updated : m));
    } catch (err) {
      alert(String(err));
    } finally {
      setSummarizing(false);
    }
  }

  async function createTaskFromItem(item: string, index: number) {
    setTaskCreating(index);
    try {
      await invoke("create_task", {
        payload: {
          title: item,
          source_type: "meeting",
          source_id: selected!.id,
          priority: "medium",
        },
      });
    } finally {
      setTaskCreating(null);
    }
  }

  async function deleteMeeting(id: number) {
    if (!confirm("Delete this meeting and its notes?")) return;
    await invoke("delete_meeting", { id });
    setMeetings((prev) => prev.filter((m) => m.id !== id));
    if (selected?.id === id) setSelected(null);
  }

  const actionItems: string[] = selected?.action_items_json
    ? JSON.parse(selected.action_items_json)
    : [];

  return (
    <div className="split-layout">
      <aside className="split-sidebar">
        <div className="split-sidebar-header">
          <h3>Meetings</h3>
          <button type="button" className="primary-button compact" onClick={() => setCreatingNew(true)}>New</button>
        </div>

        {creatingNew && (
          <div className="split-new-form">
            <input
              type="text"
              placeholder="Meeting title"
              value={newForm.title}
              onChange={(e) => setNewForm((f) => ({ ...f, title: e.target.value }))}
              autoFocus
            />
            <input
              type="date"
              value={newForm.meeting_date}
              onChange={(e) => setNewForm((f) => ({ ...f, meeting_date: e.target.value }))}
            />
            <input
              type="text"
              placeholder="Attendees (optional)"
              value={newForm.attendees}
              onChange={(e) => setNewForm((f) => ({ ...f, attendees: e.target.value }))}
            />
            <div className="split-new-form-actions">
              <button type="button" className="primary-button compact" onClick={createMeeting} disabled={!newForm.title.trim()}>Create</button>
              <button type="button" className="secondary-button compact" onClick={() => setCreatingNew(false)}>Cancel</button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="split-sidebar-empty">Loading…</p>
        ) : meetings.length === 0 ? (
          <p className="split-sidebar-empty">No meetings yet.</p>
        ) : (
          <div className="split-item-list">
            {meetings.map((m) => (
              <button
                key={m.id}
                type="button"
                className={selected?.id === m.id ? "split-item active" : "split-item"}
                onClick={() => setSelected(m)}
              >
                <span className="split-item-title">{m.title}</span>
                {m.meeting_date && <span className="split-item-meta">{m.meeting_date}</span>}
                {m.summary && <span className="split-item-tag">Summarized</span>}
              </button>
            ))}
          </div>
        )}
      </aside>

      <div className="split-content">
        {!selected ? (
          <div className="empty-state centered">
            <h3>Select a meeting</h3>
            <p>Choose a meeting from the list, or create a new one.</p>
          </div>
        ) : (
          <>
            <div className="split-content-header">
              <div>
                <h2>{selected.title}</h2>
                <div className="split-content-meta">
                  {selected.meeting_date && <span>{selected.meeting_date}</span>}
                  {selected.attendees && <span>{selected.attendees}</span>}
                </div>
              </div>
              <button type="button" className="icon-button destructive" onClick={() => deleteMeeting(selected.id)}>Delete</button>
            </div>

            <div className="meeting-notes-area">
              <label className="section-label">Meeting notes</label>
              <textarea
                className="notes-textarea"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="Paste or type your meeting notes here…"
                rows={10}
              />
              <div className="meeting-notes-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={summarize}
                  disabled={summarizing || !editNotes.trim()}
                >
                  {summarizing ? "Summarizing…" : "AI summarize"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={saveNotes}
                  disabled={savingNotes}
                >
                  {savingNotes ? "Saving…" : "Save notes"}
                </button>
              </div>
            </div>

            {selected.summary && (
              <div className="meeting-summary-block">
                <div className="section-label">Summary</div>
                <p>{selected.summary}</p>
              </div>
            )}

            {actionItems.length > 0 && (
              <div className="action-items-block">
                <div className="section-label">Action items</div>
                <ul className="action-item-list">
                  {actionItems.map((item, i) => (
                    <li key={i} className="action-item-row">
                      <span>{item}</span>
                      <button
                        type="button"
                        className="secondary-button compact"
                        onClick={() => createTaskFromItem(item, i)}
                        disabled={taskCreating === i}
                      >
                        {taskCreating === i ? "Adding…" : "Add as task"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
