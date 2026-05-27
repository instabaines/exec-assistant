import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ClientsImport } from "./features/clients/ClientsImport";
import { GenerateAndValidate } from "./features/generate/GenerateAndValidate";
import { TemplatesManager } from "./features/templates/TemplatesManager";
import { EmailSettings } from "./features/send/EmailSettings";
import { TaskManager } from "./features/tasks/TaskManager";
import { MeetingNotes } from "./features/meetings/MeetingNotes";
import { DealPipeline } from "./features/pipeline/DealPipeline";
import { DocumentDrafts } from "./features/documents/DocumentDrafts";
import { KnowledgeBase } from "./features/knowledge/KnowledgeBase";
import { AssistantChat } from "./features/assistant/AssistantChat";
import { ContactDetail } from "./features/contacts/ContactDetail";
import { HelpGuide } from "./features/help/HelpGuide";
import { OllamaSetup } from "./features/setup/OllamaSetup";
import { WelcomeSetup } from "./features/setup/WelcomeSetup";
import "./App.css";

type Screen = "home" | "contacts" | "create" | "review" | "settings" | "tasks" | "meetings" | "pipeline" | "documents" | "assistant" | "contact_detail" | "help";
type GuidedStage = "campaign" | "review";
type AsyncState = "idle" | "loading" | "success" | "error";

type StatusCard = {
  state: AsyncState;
  message: string;
};

type OllamaHealth = {
  installed: boolean;
  version: string | null;
  message: string;
};

type OllamaRunStatus = {
  running: boolean;
  source: string;
  models: string[];
};

type StoreStatus = {
  database_path: string;
  created: boolean;
};

type GenerationSettings = {
  model: string;
  default_system_prompt: string;
  sender_name: string;
  sender_position: string;
  sender_company: string;
};

type AvailableModels = {
  models: string[];
};

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

function App() {
  const [activeScreen, setActiveScreen] = useState<Screen>("home");
  const [bootstrapping, setBootstrapping] = useState(true);
  const [ollamaSetupNeeded, setOllamaSetupNeeded] = useState(false);
  const [ollamaStarting, setOllamaStarting] = useState(false);
  const [profileNeeded, setProfileNeeded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<StatusCard>({
    state: "idle",
    message: "Checking writing engine...",
  });
  const [storeStatus, setStoreStatus] = useState<StatusCard>({
    state: "idle",
    message: "Preparing secure local workspace...",
  });
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [currentModel, setCurrentModel] = useState("");
  const [settingsTick, setSettingsTick] = useState(0);
  const [modelSaving, setModelSaving] = useState(false);
  const [clientCount, setClientCount] = useState(0);
  const [focusedCampaignId, setFocusedCampaignId] = useState("all");
  const [showCreateKnowledge, setShowCreateKnowledge] = useState(false);
  const [quickAddForm, setQuickAddForm] = useState({ name: "", email: "", company: "", industry: "" });
  const [quickAddSaving, setQuickAddSaving] = useState(false);
  const [quickAddStatus, setQuickAddStatus] = useState("");
  const [briefingText, setBriefingText] = useState("");
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState<number | null>(null);
  const [workflowSummary, setWorkflowSummary] = useState<WorkflowSummary>({
    total_clients: 0,
    review_required: 0,
    approved: 0,
    sent: 0,
    exported: 0,
  });

  async function loadBriefing() {
    if (!currentModel) return;
    setBriefingLoading(true);
    try {
      const result = await invoke<{ text: string }>("get_home_briefing", { model: currentModel });
      setBriefingText(result.text);
    } catch {
      setBriefingText("");
    } finally {
      setBriefingLoading(false);
    }
  }

  function openContact(clientId: number) {
    setSelectedContactId(clientId);
    setActiveScreen("contact_detail");
  }

  async function checkOllama() {
    setOllamaStatus({ state: "loading", message: "Starting writing engine…" });
    setOllamaStarting(true);
    try {
      const status = await invoke<OllamaRunStatus>("ensure_ollama_running");
      setOllamaStarting(false);
      if (status.running) {
        const src = status.source === "sidecar" ? " (bundled)" : "";
        setOllamaStatus({ state: "success", message: `Writing engine connected${src}.` });
        if (status.models.length === 0) {
          setOllamaSetupNeeded(true);
        }
        return status.models;
      } else {
        setOllamaStatus({ state: "error", message: "Writing engine could not start." });
        return [];
      }
    } catch (error) {
      setOllamaStarting(false);
      // Fallback: try the old health check (user may have Ollama installed without the sidecar binary)
      try {
        const health = await invoke<OllamaHealth>("check_ollama_health");
        if (health.installed) {
          setOllamaStatus({ state: "success", message: "Writing engine connected." });
        } else {
          setOllamaStatus({ state: "error", message: "Writing engine not found. Install Ollama from ollama.com." });
        }
      } catch {
        setOllamaStatus({ state: "error", message: `Could not start writing engine: ${String(error)}` });
      }
      return [];
    }
  }

  async function initializeStore() {
    setStoreStatus({ state: "loading", message: "Preparing secure local workspace..." });
    try {
      const result = await invoke<StoreStatus>("initialize_local_store");
      setStoreStatus({
        state: "success",
        message: result.created ? "Secure local workspace created." : "Secure local workspace ready.",
      });
    } catch (error) {
      setStoreStatus({
        state: "error",
        message: `Could not prepare local workspace: ${String(error)}`,
      });
    }
  }

  async function refreshOverview() {
    try {
      const [clients, summary] = await Promise.all([
        invoke<ClientCount>("count_clients"),
        invoke<WorkflowSummary>("get_workflow_summary", { payload: null }),
      ]);
      setClientCount(clients.total);
      setWorkflowSummary(summary);
    } catch {
      setClientCount(0);
    }
  }

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      // Start Ollama in background — runs concurrently while user fills in profile
      const ollamaPromise = Promise.allSettled([checkOllama(), initializeStore()]);

      // Check if this is first run (no profile set yet)
      const settingsResult = await invoke<GenerationSettings>("get_generation_settings").catch(() => null);
      if (mounted && !settingsResult?.sender_name?.trim()) {
        setProfileNeeded(true);
        setBootstrapping(false);
        // Ollama continues starting in the background; we await it after profile is done
        ollamaPromise.then(async ([sidecarModels]) => {
          const localModels =
            sidecarModels.status === "fulfilled" && Array.isArray(sidecarModels.value)
              ? sidecarModels.value
              : (await invoke<AvailableModels>("list_ollama_models").catch(() => null))?.models ?? [];
          if (mounted) setAvailableModels(localModels);
          if (mounted) setCurrentModel(localModels[0] ?? "");
          await refreshOverview();
        });
        return;
      }

      // Profile already set — wait for Ollama then continue
      const [sidecarModels] = await ollamaPromise;
      let localModels: string[] = [];
      if (sidecarModels.status === "fulfilled" && Array.isArray(sidecarModels.value)) {
        localModels = sidecarModels.value;
      } else {
        localModels = (await invoke<AvailableModels>("list_ollama_models").catch(() => null))?.models ?? [];
      }

      if (mounted) {
        setAvailableModels(localModels);
        setCurrentModel(settingsResult?.model || localModels[0] || "");
      }

      await refreshOverview();

      if (mounted) {
        setBootstrapping(false);
      }
    }

    bootstrap();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!bootstrapping) {
      refreshOverview();
      if (activeScreen === "home" && currentModel && !briefingText) {
        loadBriefing();
      }
    }
  }, [activeScreen, bootstrapping]);

  async function saveModel(model: string) {
    if (!model) {
      return;
    }
    setModelSaving(true);
    try {
      const settings = await invoke<GenerationSettings>("get_generation_settings");
      await invoke("set_generation_settings", {
        payload: {
          model,
          default_system_prompt: settings.default_system_prompt,
          sender_name: settings.sender_name,
          sender_position: settings.sender_position,
          sender_company: settings.sender_company,
        },
      });
      setCurrentModel(model);
      setSettingsTick((value) => value + 1);
    } finally {
      setModelSaving(false);
    }
  }

  const workspaceReady = useMemo(
    () => ollamaStatus.state === "success" && storeStatus.state === "success",
    [ollamaStatus.state, storeStatus.state],
  );

  const screenHeadline = useMemo(() => {
    const headlines: Record<Screen, { eyebrow: string; title: string; description: string }> = {
      home: {
        eyebrow: "Executive workspace",
        title: "Good morning",
        description: "Your outreach, pipeline, tasks, and documents — all in one place.",
      },
      contacts: {
        eyebrow: "Outreach · Contacts",
        title: "Load and confirm recipients",
        description: "Upload a spreadsheet, review saved contacts, and move directly into drafting.",
      },
      create: {
        eyebrow: "Outreach · Create",
        title: "Brief the writing agent",
        description: "Describe what the message should accomplish. The agent will draft from sender and recipient details automatically.",
      },
      review: {
        eyebrow: "Outreach · Review & Send",
        title: "Approve and hand off mail",
        description: "Work through drafts one at a time, then send or schedule delivery directly from here.",
      },
      tasks: {
        eyebrow: "Work · Tasks",
        title: "Tasks",
        description: "Track action items and move work forward. Create tasks manually or push them straight from meeting notes.",
      },
      meetings: {
        eyebrow: "Work · Meetings",
        title: "Meeting notes",
        description: "Paste notes from any meeting. The AI will extract a summary and action items you can send directly to Tasks.",
      },
      documents: {
        eyebrow: "Work · Documents",
        title: "Documents",
        description: "Brief the AI on what you need — proposal, report, memo, or deck outline — and it will draft the full document.",
      },
      pipeline: {
        eyebrow: "Pipeline",
        title: "Deal pipeline",
        description: "Track every opportunity from first contact to close. Move deals through stages and keep next actions visible.",
      },
      settings: {
        eyebrow: "Settings",
        title: "Workspace configuration",
        description: "Configure email delivery, your tour booking link, sender identity, and message templates.",
      },
      assistant: {
        eyebrow: "AI Assistant",
        title: "Ask your workspace",
        description: "Your tasks, deals, meetings, outreach, and contacts — all queryable in plain language.",
      },
      help: {
        eyebrow: "Documentation",
        title: "Help & guide",
        description: "Setup instructions, feature walkthroughs, and tips for getting the most from Exec Assistant AI.",
      },
      contact_detail: {
        eyebrow: "Contacts · 360 view",
        title: "Contact profile",
        description: "Every email, deal, task, and meeting mention for this contact in one place.",
      },
    };
    return headlines[activeScreen];
  }, [activeScreen]);

  const stepIndex = useMemo(() => {
    if (activeScreen === "contacts") return 1;
    if (activeScreen === "create") return 2;
    if (activeScreen === "review") return 3;
    return 0;
  }, [activeScreen]);

  function handleStageChange(stage: GuidedStage) {
    if (stage === "review") {
      setActiveScreen("review");
      return;
    }

    setActiveScreen("create");
  }

  function renderHomeScreen() {
    const hasPendingReview = workflowSummary.review_required > 0;
    const hasApproved = workflowSummary.approved > 0;

    return (
      <>
        {hasPendingReview && (
          <div className="priority-banner" role="alert">
            <div className="priority-banner-content">
              <span className="priority-banner-dot" />
              <strong>{workflowSummary.review_required} draft{workflowSummary.review_required !== 1 ? "s" : ""} waiting for your approval</strong>
              <span className="priority-banner-sub">Review and approve to keep outreach moving.</span>
            </div>
            <button type="button" className="primary-button" onClick={() => setActiveScreen("review")}>
              Review now
            </button>
          </div>
        )}

        {hasApproved && !hasPendingReview && (
          <div className="priority-banner approved-banner" role="alert">
            <div className="priority-banner-content">
              <span className="priority-banner-dot approved" />
              <strong>{workflowSummary.approved} draft{workflowSummary.approved !== 1 ? "s" : ""} approved and ready to send</strong>
              <span className="priority-banner-sub">All looking good — schedule or send from the Review screen.</span>
            </div>
            <button type="button" className="secondary-button" onClick={() => setActiveScreen("review")}>
              Go to review
            </button>
          </div>
        )}

        <section className="hero-stage hero-stage-home">
          <div className="panel hero-home-main">
            <div className="eyebrow">What would you like to do?</div>
            <h2>Keep outreach moving without the operational clutter</h2>
            <p className="hero-copy">
              Load the right contacts, brief the agent once, review the drafts, then hand them off. Your pipeline, tasks, and documents live here too.
            </p>
            <div className="hero-actions">
              <button type="button" className="primary-button" onClick={() => setActiveScreen("create")}>Create new round</button>
              <button type="button" className="secondary-button" onClick={() => setActiveScreen("contacts")}>Upload contacts</button>
              <button type="button" className="secondary-button" onClick={() => setActiveScreen("review")}>Review mail</button>
            </div>
          </div>

          <aside className="panel executive-summary-panel">
            <div className="eyebrow">At a glance</div>
            <div className="executive-metric-grid">
              <button type="button" className="executive-metric-card accent-blue metric-clickable" onClick={() => setActiveScreen("contacts")}>
                <span>Saved contacts</span>
                <strong>{clientCount}</strong>
                <p>{clientCount > 0 ? "Ready for the next round." : "Upload your first contact file to begin."}</p>
              </button>
              <button type="button" className={`executive-metric-card accent-green metric-clickable${hasPendingReview ? " metric-urgent" : ""}`} onClick={() => setActiveScreen("review")}>
                <span>Needs review</span>
                <strong>{workflowSummary.review_required}</strong>
                <p>Drafts waiting for approval or rewrite.</p>
              </button>
              <button type="button" className="executive-metric-card accent-gold metric-clickable" onClick={() => setActiveScreen("review")}>
                <span>Approved</span>
                <strong>{workflowSummary.approved}</strong>
                <p>Ready to send or schedule.</p>
              </button>
              <button type="button" className="executive-metric-card accent-teal metric-clickable" onClick={() => setActiveScreen("review")}>
                <span>Sent</span>
                <strong>{workflowSummary.sent}</strong>
                <p>Delivered directly from this workspace.</p>
              </button>
            </div>
          </aside>
        </section>

        {/* AI Briefing */}
        <div className="panel home-briefing-panel">
          <div className="home-briefing-header">
            <div>
              <div className="eyebrow">AI briefing</div>
              <h3>What needs your attention</h3>
            </div>
            <button type="button" className="secondary-button compact" onClick={loadBriefing} disabled={briefingLoading || !currentModel}>
              {briefingLoading ? "Generating…" : "Refresh"}
            </button>
          </div>
          {briefingLoading ? (
            <div className="briefing-loading">
              <span className="chat-typing-dot" /><span className="chat-typing-dot" /><span className="chat-typing-dot" />
            </div>
          ) : briefingText ? (
            <p className="briefing-text">{briefingText}</p>
          ) : (
            <p className="briefing-text muted">{currentModel ? "Click Refresh to generate your morning briefing." : "Connect Ollama to generate briefings."}</p>
          )}
          <button type="button" className="briefing-ask-link" onClick={() => setActiveScreen("assistant")}>
            Ask the AI assistant anything about your workspace →
          </button>
        </div>

        <section className="home-action-grid">
          <button type="button" className="panel home-action-card" onClick={() => setActiveScreen("contacts")}>
            <div className="eyebrow">Step 1</div>
            <h3>Contacts</h3>
            <p>Upload a spreadsheet or add contacts one by one. Everyone is stored and ready to target.</p>
          </button>
          <button type="button" className="panel home-action-card" onClick={() => setActiveScreen("create")}>
            <div className="eyebrow">Step 2</div>
            <h3>Create</h3>
            <p>Brief the writing agent once. It drafts personalized emails for every contact automatically.</p>
          </button>
          <button type="button" className="panel home-action-card" onClick={() => setActiveScreen("review")}>
            <div className="eyebrow">Step 3</div>
            <h3>Review & Send</h3>
            <p>Approve drafts, then send immediately or schedule delivery for the right moment.</p>
          </button>
          <button type="button" className="panel home-action-card" onClick={() => setActiveScreen("assistant")}>
            <div className="eyebrow">AI Assistant</div>
            <h3>Ask your workspace</h3>
            <p>Query tasks, deals, meetings, and outreach in plain language. Get answers in seconds.</p>
          </button>
        </section>
      </>
    );
  }

  async function saveQuickContact() {
    if (!quickAddForm.name.trim() || !quickAddForm.email.trim()) return;
    setQuickAddSaving(true);
    setQuickAddStatus("");
    try {
      await invoke("add_single_client", {
        payload: {
          name: quickAddForm.name.trim(),
          email: quickAddForm.email.trim(),
          company: quickAddForm.company.trim() || null,
          industry: quickAddForm.industry.trim() || null,
        },
      });
      setQuickAddForm({ name: "", email: "", company: "", industry: "" });
      setQuickAddStatus(`${quickAddForm.name.trim()} added.`);
      refreshOverview();
    } catch (e) {
      setQuickAddStatus(`Could not add contact: ${String(e)}`);
    } finally {
      setQuickAddSaving(false);
    }
  }

  function renderContactsScreen() {
    return (
      <>
        <section className="panel page-intro-panel">
          <div>
            <div className="eyebrow">Contacts</div>
            <h2>Load the people you want to reach</h2>
            <p>
              Bring in the spreadsheet your team already uses, or add a single lead directly below.
            </p>
          </div>
          <div className="page-intro-actions">
            <button type="button" className="secondary-button" onClick={() => setShowSettings((value) => !value)}>
              {showSettings ? "Hide sender settings" : "Edit sender settings"}
            </button>
          </div>
        </section>

        <div className="panel quick-add-panel">
          <div className="quick-add-header">
            <div>
              <div className="eyebrow">Quick add</div>
              <h3>Add a single contact</h3>
            </div>
            {quickAddStatus && <p className={`quick-add-status${quickAddStatus.includes("Could not") ? " error" : " success"}`}>{quickAddStatus}</p>}
          </div>
          <div className="form-grid four-col">
            <div className="mapping-row">
              <label>Full name *</label>
              <input
                type="text"
                value={quickAddForm.name}
                onChange={(e) => setQuickAddForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Jane Smith"
                onKeyDown={(e) => e.key === "Enter" && saveQuickContact()}
              />
            </div>
            <div className="mapping-row">
              <label>Email *</label>
              <input
                type="email"
                value={quickAddForm.email}
                onChange={(e) => setQuickAddForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="jane@company.com"
                onKeyDown={(e) => e.key === "Enter" && saveQuickContact()}
              />
            </div>
            <div className="mapping-row">
              <label>Company</label>
              <input
                type="text"
                value={quickAddForm.company}
                onChange={(e) => setQuickAddForm((f) => ({ ...f, company: e.target.value }))}
                placeholder="Acme Corp"
                onKeyDown={(e) => e.key === "Enter" && saveQuickContact()}
              />
            </div>
            <div className="mapping-row">
              <label>Industry</label>
              <input
                type="text"
                value={quickAddForm.industry}
                onChange={(e) => setQuickAddForm((f) => ({ ...f, industry: e.target.value }))}
                placeholder="Retail"
                onKeyDown={(e) => e.key === "Enter" && saveQuickContact()}
              />
            </div>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="primary-button"
              onClick={saveQuickContact}
              disabled={quickAddSaving || !quickAddForm.name.trim() || !quickAddForm.email.trim()}
            >
              {quickAddSaving ? "Adding…" : "Add contact"}
            </button>
          </div>
        </div>

        {showSettings ? <TemplatesManager /> : null}
        <ClientsImport
          onContinue={() => {
            refreshOverview();
            setActiveScreen("create");
          }}
          onOpenContact={openContact}
        />
      </>
    );
  }

  function renderCreateScreen() {
    const focusedId = focusedCampaignId !== "all" ? Number(focusedCampaignId) : null;
    return (
      <>
        <section className="panel page-intro-panel">
          <div>
            <div className="eyebrow">Create</div>
            <h2>Brief the writing agent</h2>
            <p>
              Keep this simple: describe the offer, the audience, and the outcome you want. The app will combine that
              with sender details and recipient data to prepare review-ready drafts.
            </p>
          </div>
          <div className="page-intro-side">
            <div className="snapshot-card compact">
              <span>Contacts available</span>
              <strong>{clientCount}</strong>
            </div>
            <button
              type="button"
              className={showCreateKnowledge ? "secondary-button active-toggle" : "secondary-button"}
              onClick={() => setShowCreateKnowledge((v) => !v)}
            >
              {showCreateKnowledge ? "Hide knowledge docs" : "Manage knowledge docs"}
            </button>
            <button type="button" className="secondary-button" onClick={() => setShowSettings((value) => !value)}>
              {showSettings ? "Hide sender settings" : "Edit sender settings"}
            </button>
          </div>
        </section>

        {showCreateKnowledge ? (
          <div className="panel create-knowledge-panel">
            <KnowledgeBase campaignId={focusedId} compact={false} />
          </div>
        ) : null}

        {showSettings ? <TemplatesManager /> : null}

        <GenerateAndValidate
          model={currentModel}
          settingsTick={settingsTick}
          activeStage="campaign"
          onStageChange={handleStageChange}
          initialCampaignId={focusedCampaignId}
          onCampaignFocusChange={setFocusedCampaignId}
        />
      </>
    );
  }

  function renderReviewScreen() {
    return (
      <GenerateAndValidate
        model={currentModel}
        settingsTick={settingsTick}
        activeStage="review"
        onStageChange={handleStageChange}
        initialCampaignId={focusedCampaignId}
        onCampaignFocusChange={setFocusedCampaignId}
      />
    );
  }

  function renderSettingsScreen() {
    return (
      <>
        <section className="panel page-intro-panel">
          <div>
            <div className="eyebrow">Settings</div>
            <h2>Workspace configuration</h2>
            <p>
              Set up email delivery so you can send directly from the Review screen.
              Add your tour booking link and it appears in every email automatically.
            </p>
          </div>
        </section>

        <section className="panel settings-section">
          <div className="settings-section-header">
            <h3>Writing model</h3>
            <p>Select the Ollama model used to generate email drafts. Changes take effect immediately.</p>
          </div>
          <div className="settings-field-row">
            <label className="settings-label" htmlFor="model-select">Active model</label>
            <select
              id="model-select"
              className="settings-select"
              value={currentModel}
              onChange={(event) => saveModel(event.target.value)}
              disabled={modelSaving}
            >
              {availableModels.length === 0 ? (
                <option value="">No Ollama models detected</option>
              ) : (
                availableModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))
              )}
            </select>
            <button
              type="button"
              className="secondary-button"
              onClick={checkOllama}
              disabled={ollamaStatus.state === "loading"}
            >
              Recheck connection
            </button>
          </div>
          <div className={`settings-status-line ${ollamaStatus.state}`}>
            {ollamaStatus.message}
          </div>
        </section>

        <KnowledgeBase />
        <EmailSettings />
        <TemplatesManager />
      </>
    );
  }

  function navItem(screen: Screen, label: string) {
    return (
      <button
        type="button"
        className={activeScreen === screen ? "sidebar-nav-item active" : "sidebar-nav-item"}
        onClick={() => setActiveScreen(screen)}
      >
        {label}
      </button>
    );
  }

  const outreachScreens: Screen[] = ["contacts", "create", "review"];
  const isOutreach = outreachScreens.includes(activeScreen);

  if (ollamaStarting && bootstrapping) {
    return (
      <div className="ollama-starting-shell">
        <div className="ollama-starting-card">
          <div className="ollama-starting-spinner" />
          <p>Starting writing engine…</p>
        </div>
      </div>
    );
  }

  if (!bootstrapping && profileNeeded) {
    return (
      <WelcomeSetup
        onComplete={async () => {
          setProfileNeeded(false);
          // Re-read settings now that profile is saved
          const s = await invoke<GenerationSettings>("get_generation_settings").catch(() => null);
          if (s) setCurrentModel(s.model || availableModels[0] || "");
          // Check if models still need to be downloaded
          if (availableModels.length === 0) {
            setOllamaSetupNeeded(true);
          }
          await refreshOverview();
        }}
      />
    );
  }

  if (!bootstrapping && ollamaSetupNeeded) {
    return (
      <OllamaSetup
        onReady={(model) => {
          setOllamaSetupNeeded(false);
          setAvailableModels((prev) => (prev.includes(model) ? prev : [model, ...prev]));
          if (!currentModel) setCurrentModel(model);
        }}
      />
    );
  }

  return (
    <div className="app-shell sidebar-shell">
      <nav className="sidebar" aria-label="Navigation">
        <div className="sidebar-brand" onClick={() => setActiveScreen("home")}>
          <img src="/src/assets/logo.png" alt="Exec Assistant AI" className="sidebar-logo" />
        </div>

        <div className="sidebar-section">
          {navItem("home", "Home")}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-label">Outreach</div>
          {navItem("contacts", "Contacts")}
          {navItem("create", "Create")}
          {navItem("review", "Review & Send")}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-label">Work</div>
          {navItem("tasks", "Tasks")}
          {navItem("meetings", "Meetings")}
          {navItem("documents", "Documents")}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-label">Pipeline</div>
          {navItem("pipeline", "Deals")}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-label">Intelligence</div>
          {navItem("assistant", "AI Assistant")}
        </div>

        <div className="sidebar-section">
          {navItem("help", "Help & Guide")}
        </div>

        <div className="sidebar-footer">
          <div className={workspaceReady ? "sidebar-status ready" : bootstrapping ? "sidebar-status loading" : "sidebar-status attention"}>
            {bootstrapping ? "Starting up…" : workspaceReady ? "Ready" : "Needs attention"}
          </div>
          {navItem("settings", "Settings")}
        </div>
      </nav>

      <div className="sidebar-content-area">
        <header className="content-header">
          <div className="content-header-text">
            <div className="eyebrow">{screenHeadline.eyebrow}</div>
            <h1>{screenHeadline.title}</h1>
          </div>
          <div className="content-header-meta">
            <div className="snapshot-card compact">
              <span>Model</span>
              <strong>{currentModel || "—"}</strong>
            </div>
          </div>
        </header>

        {isOutreach && (
          <div className="step-progress-strip">
            <div className={stepIndex >= 1 ? "step-pill complete" : "step-pill"}>1. Contacts</div>
            <div className={stepIndex >= 2 ? "step-pill complete" : "step-pill"}>2. Create</div>
            <div className={stepIndex >= 3 ? "step-pill complete" : "step-pill"}>3. Review</div>
          </div>
        )}

        <section className="content sidebar-page-content">
          {activeScreen === "home" ? renderHomeScreen() : null}
          {activeScreen === "contacts" ? renderContactsScreen() : null}
          {activeScreen === "create" ? renderCreateScreen() : null}
          {activeScreen === "review" ? renderReviewScreen() : null}
          {activeScreen === "tasks" ? <TaskManager /> : null}
          {activeScreen === "meetings" ? <MeetingNotes model={currentModel} /> : null}
          {activeScreen === "pipeline" ? <DealPipeline /> : null}
          {activeScreen === "documents" ? <DocumentDrafts model={currentModel} /> : null}
          {activeScreen === "settings" ? renderSettingsScreen() : null}
          {activeScreen === "assistant" ? <AssistantChat model={currentModel} /> : null}
          {activeScreen === "help" ? <HelpGuide /> : null}
          {activeScreen === "contact_detail" && selectedContactId !== null ? (
            <ContactDetail clientId={selectedContactId} onBack={() => setActiveScreen("contacts")} />
          ) : null}
        </section>
      </div>
    </div>
  );
}

export default App;
