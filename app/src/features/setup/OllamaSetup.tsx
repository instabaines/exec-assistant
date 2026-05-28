import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type PullProgress = {
  status: string;
  total?: number;
  completed?: number;
};

type Props = {
  onReady: (model: string) => void;
};

const DEFAULT_MODEL = "gemma4";

export function OllamaSetup({ onReady }: Props) {
  const [phase, setPhase] = useState<"downloading" | "done" | "error">("downloading");
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [retrying, setRetrying] = useState(false);

  async function startDownload() {
    setPhase("downloading");
    setProgress(null);
    try {
      await invoke("pull_ollama_model", { model: DEFAULT_MODEL });
    } catch {
      // error comes through the event, not the return value
    }
  }

  useEffect(() => {
    const unlistenProgress = listen<PullProgress>("ollama-pull-progress", (e) => {
      setProgress(e.payload);
    });

    const unlistenComplete = listen<string>("ollama-pull-complete", (e) => {
      setPhase("done");
      setTimeout(() => onReady(e.payload), 900);
    });

    const unlistenError = listen<string>("ollama-pull-error", () => {
      setPhase("error");
      setRetrying(false);
    });

    // Start immediately — no user action required
    startDownload();

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function retry() {
    setRetrying(true);
    await startDownload();
  }

  const pct =
    progress?.total && progress.completed
      ? Math.round((progress.completed / progress.total) * 100)
      : null;

  const statusLabel =
    progress?.status === "success"
      ? "Finalising…"
      : progress?.status?.startsWith("pulling")
      ? `Downloading your AI model${pct !== null ? ` — ${pct}%` : "…"}`
      : progress?.status
      ? progress.status
      : "Connecting to AI engine…";

  return (
    <div className="ollama-setup-shell">
      <div className="ollama-setup-card">
        <img src="/src/assets/logo.png" alt="Exec Assistant AI" className="ollama-setup-logo" />

        {phase === "downloading" && (
          <>
            <h1>Setting up your AI</h1>
            <p className="ollama-setup-subtitle">
              Downloading your private AI model — this happens once. Everything runs locally;
              nothing leaves your device.
            </p>
            <div className="ollama-download-progress">
              <p className="ollama-download-status">{statusLabel}</p>
              <div className="ollama-progress-bar">
                <div
                  className="ollama-progress-fill"
                  style={{ width: pct !== null ? `${pct}%` : "5%" }}
                />
              </div>
              {pct !== null && <p className="ollama-progress-pct">{pct}%</p>}
              <p className="ollama-download-hint">
                Subsequent launches start instantly — this step won't repeat.
              </p>
            </div>
          </>
        )}

        {phase === "done" && (
          <div className="ollama-done">
            <div className="ollama-done-check">✓</div>
            <p>AI model ready — launching…</p>
          </div>
        )}

        {phase === "error" && (
          <>
            <h1>Download paused</h1>
            <p className="ollama-setup-subtitle">
              The AI model couldn't be downloaded. Check your internet connection and try again —
              the download will resume where it left off.
            </p>
            <button
              type="button"
              className="primary-button"
              onClick={retry}
              disabled={retrying}
            >
              {retrying ? "Retrying…" : "Try again"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
