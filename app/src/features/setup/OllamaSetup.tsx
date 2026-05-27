import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type PullProgress = {
  status: string;
  total?: number;
  completed?: number;
  digest?: string;
};

type Props = {
  onReady: (model: string) => void;
};

const RECOMMENDED_MODELS = [
  { id: "mistral", label: "Mistral 7B", size: "4.1 GB", note: "Recommended — best quality/speed balance" },
  { id: "llama3.2", label: "Llama 3.2 3B", size: "2.0 GB", note: "Faster, lighter, good for most tasks" },
  { id: "phi3", label: "Phi-3 Mini", size: "2.3 GB", note: "Very fast, lower memory usage" },
];

export function OllamaSetup({ onReady }: Props) {
  const [selected, setSelected] = useState("mistral");
  const [phase, setPhase] = useState<"pick" | "downloading" | "done">("pick");
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const unlisten = listen<PullProgress>("ollama-pull-progress", (event) => {
      setProgress(event.payload);
    });

    const unlistenComplete = listen<string>("ollama-pull-complete", (event) => {
      setPhase("done");
      setTimeout(() => onReady(event.payload), 800);
    });

    const unlistenError = listen<string>("ollama-pull-error", (event) => {
      setError(event.payload);
      setPhase("pick");
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [onReady]);

  async function startDownload() {
    setError("");
    setPhase("downloading");
    setProgress(null);
    try {
      await invoke("pull_ollama_model", { model: selected });
    } catch (err) {
      setError(String(err));
      setPhase("pick");
    }
  }

  const pct = progress?.total && progress.completed
    ? Math.round((progress.completed / progress.total) * 100)
    : null;

  const statusLabel = progress?.status === "success"
    ? "Finalising…"
    : progress?.status?.startsWith("pulling")
    ? `Downloading${pct !== null ? ` — ${pct}%` : "…"}`
    : progress?.status ?? "Starting download…";

  return (
    <div className="ollama-setup-shell">
      <div className="ollama-setup-card">
        <div className="ollama-setup-icon">🧠</div>
        <h1>One-time model setup</h1>
        <p className="ollama-setup-subtitle">
          Evo uses a local AI model — all processing stays on your device, nothing leaves your machine.
          Choose a model to download now.
        </p>

        {phase === "pick" && (
          <>
            <div className="ollama-model-list">
              {RECOMMENDED_MODELS.map((m) => (
                <label key={m.id} className={`ollama-model-row${selected === m.id ? " selected" : ""}`}>
                  <input
                    type="radio"
                    name="model"
                    value={m.id}
                    checked={selected === m.id}
                    onChange={() => setSelected(m.id)}
                  />
                  <div className="ollama-model-info">
                    <span className="ollama-model-name">{m.label}</span>
                    <span className="ollama-model-size">{m.size}</span>
                  </div>
                  <span className="ollama-model-note">{m.note}</span>
                </label>
              ))}
            </div>

            {error && <p className="status error">{error}</p>}

            <button type="button" className="primary-button" onClick={startDownload}>
              Download {RECOMMENDED_MODELS.find((m) => m.id === selected)?.label}
            </button>
            <p className="ollama-setup-hint">
              Download happens once. The model is stored locally and reused on every launch.
            </p>
          </>
        )}

        {phase === "downloading" && (
          <div className="ollama-download-progress">
            <p className="ollama-download-status">{statusLabel}</p>
            <div className="ollama-progress-bar">
              <div
                className="ollama-progress-fill"
                style={{ width: pct !== null ? `${pct}%` : "0%" }}
              />
            </div>
            {pct !== null && <p className="ollama-progress-pct">{pct}%</p>}
            <p className="ollama-download-hint">
              This only happens once — subsequent launches start instantly.
            </p>
          </div>
        )}

        {phase === "done" && (
          <div className="ollama-done">
            <div className="ollama-done-check">✓</div>
            <p>Model ready — launching Evo…</p>
          </div>
        )}
      </div>
    </div>
  );
}
