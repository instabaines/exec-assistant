import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ClientCount = {
  total: number;
};

type WorkflowSummary = {
  total_clients: number;
  review_required: number;
  approved: number;
  sent: number;
  exported: number;
};

type HistoryRecord = {
  id: number;
  client_name: string;
  event_type: string;
  detail: string;
  happened_at: string;
  status: string;
};

type Props = {
  onOpenContacts: () => void;
  onOpenCampaign: () => void;
  onOpenReview: () => void;
};

export function WorkspaceHome({ onOpenContacts, onOpenCampaign, onOpenReview }: Props) {
  const [clientCount, setClientCount] = useState(0);
  const [summary, setSummary] = useState<WorkflowSummary>({
    total_clients: 0,
    review_required: 0,
    approved: 0,
    sent: 0,
    exported: 0,
  });
  const [history, setHistory] = useState<HistoryRecord[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const [clients, workflow, historyList] = await Promise.all([
          invoke<ClientCount>("count_clients"),
          invoke<WorkflowSummary>("get_workflow_summary"),
          invoke<HistoryRecord[]>("list_history"),
        ]);
        setClientCount(clients.total);
        setSummary(workflow);
        setHistory(historyList.slice(0, 4));
      } catch {
        // Keep the splash page calm even if background numbers fail.
      }
    }

    load();
  }, []);

  return (
    <>
      <section className="panel splash-panel">
        <div className="eyebrow">Mail Operations</div>
        <h2>Enterprise outreach workspace</h2>
        <p>
          Start from the page that matches the job at hand: bring in contact data, continue a stored contact list, or review previous mail activity.
        </p>

        <div className="splash-grid">
          <button type="button" className="splash-card splash-card-primary" onClick={onOpenContacts}>
            <span>Upload contacts</span>
            <strong>Import a new spreadsheet</strong>
            <p>Load Excel data, map the important fields once, and save the contacts into the local database.</p>
          </button>

          <button type="button" className="splash-card" onClick={onOpenContacts}>
            <span>Review contacts</span>
            <strong>{clientCount} contacts already stored</strong>
            <p>Open the contacts page to review imported records and continue from the database you already have.</p>
          </button>

          <button type="button" className="splash-card" onClick={onOpenReview}>
            <span>Review previous mail</span>
            <strong>{summary.approved} approved drafts and recent history</strong>
            <p>Go straight into the review page to inspect earlier drafts, approvals, downloads, and recent activity.</p>
          </button>
        </div>
      </section>

      <section className="home-summary-grid">
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Quick status</h2>
              <p>A simple snapshot of what is waiting in the system.</p>
            </div>
          </div>
          <div className="summary-stack">
            <div className="summary-card">
              <span>Stored contacts</span>
              <strong>{summary.total_clients}</strong>
            </div>
            <div className="summary-card">
              <span>Need review</span>
              <strong>{summary.review_required}</strong>
            </div>
            <div className="summary-card">
              <span>Approved</span>
              <strong>{summary.approved}</strong>
            </div>
          </div>
          <div className="panel-actions">
            <button type="button" className="primary-button" onClick={onOpenCampaign}>
              Create email round
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <h2>Recent mail activity</h2>
              <p>The most recent export and review events.</p>
            </div>
          </div>
          {history.length === 0 ? (
            <div className="empty-state">
              <h3>No history yet</h3>
              <p>Once drafts are reviewed or exported, the latest events will appear here.</p>
            </div>
          ) : (
            <div className="home-history-list">
              {history.map((item) => (
                <div key={item.id} className="home-history-item">
                  <strong>{item.client_name}</strong>
                  <span>{item.event_type}</span>
                  <small>{item.happened_at}</small>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
