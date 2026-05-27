import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type TaskStatus = "todo" | "in_progress" | "done";
type TaskPriority = "high" | "medium" | "low";

type Task = {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  source_type: string | null;
  source_id: number | null;
  created_at: string;
  updated_at: string;
};

const PRIORITY_LABEL: Record<TaskPriority, string> = { high: "High", medium: "Medium", low: "Low" };
const STATUS_LABEL: Record<TaskStatus, string> = { todo: "To do", in_progress: "In progress", done: "Done" };

const STAGES: TaskStatus[] = ["todo", "in_progress", "done"];

export function TaskManager() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeStatus, setActiveStatus] = useState<TaskStatus | "all">("all");
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState({ title: "", description: "", priority: "medium" as TaskPriority, due_date: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await invoke<Task[]>("list_tasks");
      setTasks(result);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function openNew() {
    setForm({ title: "", description: "", priority: "medium", due_date: "" });
    setEditingId("new");
  }

  function openEdit(task: Task) {
    setForm({
      title: task.title,
      description: task.description ?? "",
      priority: task.priority as TaskPriority,
      due_date: task.due_date ?? "",
    });
    setEditingId(task.id);
  }

  async function saveTask() {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      if (editingId === "new") {
        await invoke("create_task", {
          payload: {
            title: form.title.trim(),
            description: form.description.trim() || null,
            priority: form.priority,
            due_date: form.due_date || null,
          },
        });
      } else {
        await invoke("update_task", {
          payload: {
            id: editingId,
            title: form.title.trim(),
            description: form.description.trim() || null,
            priority: form.priority,
            due_date: form.due_date || null,
          },
        });
      }
      setEditingId(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function moveStatus(task: Task, status: TaskStatus) {
    await invoke("update_task", { payload: { id: task.id, status } });
    setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, status } : t));
  }

  async function deleteTask(id: number) {
    if (!confirm("Delete this task?")) return;
    await invoke("delete_task", { id });
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = (t: Task) => t.due_date && t.due_date < today && t.status !== "done";

  const filtered = activeStatus === "all" ? tasks : tasks.filter((t) => t.status === activeStatus);
  const overdueCount = tasks.filter((t) => isOverdue(t)).length;

  const counts: Record<string, number> = { all: tasks.length };
  for (const s of STAGES) counts[s] = tasks.filter((t) => t.status === s).length;

  return (
    <div className="feature-shell">
      <div className="feature-toolbar">
        <div className="filter-tab-row">
          {(["all", ...STAGES] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={activeStatus === s ? "filter-tab active" : "filter-tab"}
              onClick={() => setActiveStatus(s)}
            >
              {s === "all" ? "All" : STATUS_LABEL[s]}
              <span className="filter-tab-count">{counts[s]}</span>
            </button>
          ))}
          {overdueCount > 0 && (
            <span className="overdue-tab-badge">{overdueCount} overdue</span>
          )}
        </div>
        <button type="button" className="primary-button" onClick={openNew}>New task</button>
      </div>

      {editingId !== null && (
        <div className="panel form-panel">
          <h3>{editingId === "new" ? "New task" : "Edit task"}</h3>
          <div className="form-grid two-col">
            <div className="mapping-row full-span">
              <label>Title</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="What needs to happen?"
                autoFocus
              />
            </div>
            <div className="mapping-row full-span">
              <label>Notes</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional context or details"
                rows={2}
              />
            </div>
            <div className="mapping-row">
              <label>Priority</label>
              <select value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as TaskPriority }))}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div className="mapping-row">
              <label>Due date</label>
              <input type="date" value={form.due_date} onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="primary-button" onClick={saveTask} disabled={saving || !form.title.trim()}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty-state"><p>Loading tasks…</p></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <h3>No tasks here</h3>
          <p>{activeStatus === "all" ? "Create your first task to get started." : `No ${STATUS_LABEL[activeStatus as TaskStatus]} tasks.`}</p>
        </div>
      ) : (
        <div className="task-list">
          {filtered.map((task) => (
            <div key={task.id} className={`task-card priority-${task.priority}${isOverdue(task) ? " task-overdue-card" : ""}`}>
              <div className="task-card-main">
                <div className="task-card-header">
                  <span className={`task-status-badge status-${task.status}`}>{STATUS_LABEL[task.status]}</span>
                  <span className={`priority-badge priority-${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>
                  {task.due_date && (
                    <span className={`task-due${isOverdue(task) ? " task-due-overdue" : ""}`}>
                      {isOverdue(task) ? "Overdue · " : ""}{task.due_date}
                    </span>
                  )}
                  {task.source_type === "meeting" && <span className="task-source-badge">From meeting</span>}
                </div>
                <div className="task-title">{task.title}</div>
                {task.description && <p className="task-description">{task.description}</p>}
              </div>
              <div className="task-card-actions">
                <select
                  value={task.status}
                  onChange={(e) => moveStatus(task, e.target.value as TaskStatus)}
                  className="task-status-select"
                >
                  {STAGES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
                <button type="button" className="icon-button" onClick={() => openEdit(task)}>Edit</button>
                <button type="button" className="icon-button destructive" onClick={() => deleteTask(task.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
