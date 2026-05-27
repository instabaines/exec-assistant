import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

type DraftRecord = {
  id: number;
  campaign_id: number;
  campaign_name: string;
  client_id: number;
  client_name: string;
  client_email: string;
  client_industry: string;
  client_company: string;
  subject: string;
  body: string;
  status: string;
  template_name: string;
  created_at: string;
  generation_mode: string;
  generation_label: string;
  needs_attention: boolean;
};

type CampaignRecord = {
  id: number;
  name: string;
  status: string;
  created_at: string;
  draft_count: number;
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
  draft_id: number;
  client_name: string;
  client_email: string;
  event_type: string;
  detail: string;
  happened_at: string;
  status: string;
};

type GenerationJobStatus = {
  id: number;
  status: string;
  campaign_id: number;
  total_count: number;
  generated_count: number;
  flagged_count: number;
  failed_count: number;
  current_client_name: string | null;
  error_message: string | null;
};

type GenerationProgressEvent = {
  job: GenerationJobStatus;
  draft: DraftRecord | null;
};

type DraftLocalState = DraftRecord & {
  fine_tune_instruction: string;
};

type SendProgressEvent = {
  draft_id: number | null;
  client_name: string | null;
  status: string;
  error: string | null;
  sent_count: number;
  failed_count: number;
  total_count: number;
  done: boolean;
};

type CampaignSendStatus = {
  campaign_id: number;
  campaign_name: string;
  approved_count: number;
  sent_count: number;
  scheduled_at: string | null;
};

type ContactHistoryRecord = {
  campaign_name: string;
  subject: string;
  body_preview: string;
  status: string;
  created_at: string;
};

type Props = {
  model: string;
  settingsTick: number;
  activeStage: "campaign" | "review";
  onStageChange: (stage: "campaign" | "review") => void;
  initialCampaignId?: string;
  onCampaignFocusChange?: (campaignId: string) => void;
};

const FILTERS = [
  { value: "all", label: "All drafts" },
  { value: "review_required", label: "Needs review" },
  { value: "refine_requested", label: "Needs rewrite" },
  { value: "approved", label: "Approved" },
];

function toLocalDraft(draft: DraftRecord, existing?: DraftLocalState): DraftLocalState {
  return {
    ...draft,
    fine_tune_instruction: existing?.fine_tune_instruction ?? "",
  };
}

function mergeDrafts(
  incoming: DraftRecord[],
  previous: DraftLocalState[],
  dirtyDraftIds: Set<number>,
): DraftLocalState[] {
  const previousById = new Map(previous.map((draft) => [draft.id, draft]));

  return incoming.map((draft) => {
    const existing = previousById.get(draft.id);
    if (!existing) {
      return toLocalDraft(draft);
    }

    if (!dirtyDraftIds.has(draft.id)) {
      return toLocalDraft(draft, existing);
    }

    return {
      ...toLocalDraft(draft, existing),
      subject: existing.subject,
      body: existing.body,
      fine_tune_instruction: existing.fine_tune_instruction,
    };
  });
}

function buildRoundNameFromBrief(brief: string) {
  const compact = brief
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");

  if (!compact) {
    return `Outreach round ${new Date().toLocaleDateString()}`;
  }

  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

export function GenerateAndValidate({
  model,
  settingsTick,
  activeStage,
  onStageChange,
  initialCampaignId = "all",
  onCampaignFocusChange,
}: Props) {
  const [drafts, setDrafts] = useState<DraftLocalState[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [summary, setSummary] = useState<WorkflowSummary>({
    total_clients: 0,
    review_required: 0,
    approved: 0,
    sent: 0,
    exported: 0,
  });
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDraftId, setSelectedDraftId] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>(initialCampaignId);
  const [batchSize] = useState(50);
  const [campaignName, setCampaignName] = useState("");
  const [campaignBrief, setCampaignBrief] = useState("");
  const [callToAction, setCallToAction] = useState("");
  const [status, setStatus] = useState("Agent workspace ready.");
  const [busy, setBusy] = useState(false);
  const [resettingRounds, setResettingRounds] = useState(false);
  const [generationJob, setGenerationJob] = useState<GenerationJobStatus | null>(null);
  const [dirtyDraftIds, setDirtyDraftIds] = useState<number[]>([]);
  const [reviewSection, setReviewSection] = useState<"drafts" | "history">("drafts");
  const [sendProgress, setSendProgress] = useState<SendProgressEvent | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sendStatus, setSendStatus] = useState("");
  const [campaignSendStatus, setCampaignSendStatus] = useState<CampaignSendStatus | null>(null);
  const [showScheduler, setShowScheduler] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [useAgentPipeline, setUseAgentPipeline] = useState(false);
  const [contactHistory, setContactHistory] = useState<ContactHistoryRecord[]>([]);
  const [showContactHistory, setShowContactHistory] = useState(false);
  const selectedCampaignIdRef = useRef(selectedCampaignId);
  const dirtyDraftIdsRef = useRef(dirtyDraftIds);

  useEffect(() => {
    setSelectedCampaignId(initialCampaignId);
  }, [initialCampaignId]);

  useEffect(() => {
    selectedCampaignIdRef.current = selectedCampaignId;
  }, [selectedCampaignId]);

  useEffect(() => {
    dirtyDraftIdsRef.current = dirtyDraftIds;
  }, [dirtyDraftIds]);

  function changeCampaignFocus(campaignId: string) {
    setSelectedCampaignId(campaignId);
    onCampaignFocusChange?.(campaignId);
  }

  const filteredDrafts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return drafts.filter((draft) => {
      const matchesStatus = statusFilter === "all" ? true : draft.status === statusFilter;
      const matchesSearch =
        query.length === 0
          ? true
          : [
              draft.client_name,
              draft.client_company,
              draft.client_email,
              draft.subject,
              draft.template_name,
              draft.client_industry,
            ]
              .join(" ")
              .toLowerCase()
              .includes(query);
      return matchesStatus && matchesSearch;
    });
  }, [drafts, searchQuery, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredDrafts.length / pageSize));
  const pageStart = (currentPage - 1) * pageSize;
  const pagedDrafts = filteredDrafts.slice(pageStart, pageStart + pageSize);
  const selectedDraft = filteredDrafts.find((draft) => draft.id === selectedDraftId) ?? pagedDrafts[0] ?? null;
  const selectedDraftIndex = selectedDraft ? filteredDrafts.findIndex((draft) => draft.id === selectedDraft.id) : -1;

  const selectedCampaign = useMemo(
    () => campaigns.find((campaign) => String(campaign.id) === selectedCampaignId) ?? null,
    [campaigns, selectedCampaignId],
  );
  const queueHeadline =
    selectedCampaignId === "all"
      ? "All outreach rounds"
      : selectedCampaign
        ? selectedCampaign.name
        : "Selected round";
  const isGenerating = generationJob?.status === "running";
  const generationPercent = useMemo(() => {
    if (!generationJob || generationJob.total_count === 0) {
      return 0;
    }
    return Math.min(
      100,
      Math.round(((generationJob.generated_count + generationJob.failed_count) / generationJob.total_count) * 100),
    );
  }, [generationJob]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  useEffect(() => {
    if (filteredDrafts.length === 0) {
      setSelectedDraftId(null);
      return;
    }
    if (!selectedDraftId || !filteredDrafts.some((draft) => draft.id === selectedDraftId)) {
      setSelectedDraftId(filteredDrafts[0].id);
    }
  }, [filteredDrafts, selectedDraftId]);

  useEffect(() => {
    setShowContactHistory(false);
    setContactHistory([]);
    if (!selectedDraft?.client_email) return;
    invoke<ContactHistoryRecord[]>("get_contact_history", { email: selectedDraft.client_email })
      .then(setContactHistory)
      .catch(() => {});
  }, [selectedDraft?.client_email]);

  async function refreshData(options?: { silent?: boolean; preserveEdits?: boolean }) {
    if (!options?.silent) {
      setStatus("Refreshing draft queue...");
    }
    try {
      const campaignFilter = selectedCampaignId === "all" ? null : Number(selectedCampaignId);
      const [draftList, summaryData, historyData, campaignList] = await Promise.all([
        invoke<DraftRecord[]>("list_drafts", {
          payload: { campaign_id: campaignFilter },
        }),
        invoke<WorkflowSummary>("get_workflow_summary", {
          payload: { campaign_id: campaignFilter },
        }),
        invoke<HistoryRecord[]>("list_history", {
          payload: { campaign_id: campaignFilter },
        }),
        invoke<CampaignRecord[]>("list_campaigns"),
      ]);

      setDrafts((previous) =>
        options?.preserveEdits === false
          ? draftList.map((draft) => toLocalDraft(draft))
          : mergeDrafts(draftList, previous, new Set(dirtyDraftIdsRef.current)),
      );
      setSummary(summaryData);
      setHistory(historyData);
      setCampaigns(campaignList);
      if (!options?.silent) {
        setStatus("Draft queue is up to date.");
      }
    } catch (error) {
      setStatus(`Could not load the draft queue: ${String(error)}`);
    }
  }

  useEffect(() => {
    refreshData();
  }, [settingsTick, selectedCampaignId]);

  useEffect(() => {
    let cancelled = false;
    let unlistenPromise: Promise<() => void> | undefined;
    let fallbackTimer: number | undefined;

    function applyIncomingDraft(draft: DraftRecord) {
      const visibleInCurrentView =
        selectedCampaignIdRef.current === "all" || selectedCampaignIdRef.current === String(draft.campaign_id);

      if (!visibleInCurrentView) {
        return;
      }

      setDrafts((previous) => {
        const existing = previous.find((item) => item.id === draft.id);
        const merged =
          existing && dirtyDraftIdsRef.current.includes(draft.id)
            ? {
                ...toLocalDraft(draft, existing),
                subject: existing.subject,
                body: existing.body,
                fine_tune_instruction: existing.fine_tune_instruction,
              }
            : toLocalDraft(draft, existing);
        if (existing) {
          return previous.map((item) => (item.id === draft.id ? merged : item));
        }
        return [merged, ...previous];
      });
    }

    async function handleJob(job: GenerationJobStatus | null, draft?: DraftRecord | null) {
      if (cancelled) {
        return;
      }

      setGenerationJob(job);

      if (!job) {
        return;
      }

      if (draft) {
        applyIncomingDraft(draft);
      }

      if (job.status === "running") {
        setStatus(
          `Generating drafts: ${job.generated_count} of ${job.total_count} complete${
            job.current_client_name ? `, now working on ${job.current_client_name}` : ""
          }.`,
        );
        return;
      }

      if (job.status === "completed") {
        setStatus(
          `Draft generation finished. ${job.generated_count} created, ${job.flagged_count} need attention, ${job.failed_count} failed.`,
        );
        await refreshData({ silent: true });
        return;
      }

      if (job.status === "failed") {
        setStatus(job.error_message || "Draft generation failed.");
        await refreshData({ silent: true });
      }
    }

    async function loadCurrentJob() {
      try {
        const job = await invoke<GenerationJobStatus | null>("get_generation_job_status");
        if (cancelled) {
          return;
        }
        await handleJob(job);
        if (job?.status === "running") {
          await refreshData({ silent: true });
        }
      } catch {
        if (!cancelled) {
          setGenerationJob(null);
        }
      }
    }

    unlistenPromise = listen<GenerationProgressEvent>("generation-progress", async (event) => {
      await handleJob(event.payload.job, event.payload.draft);
    });

    loadCurrentJob();

    fallbackTimer = window.setInterval(async () => {
      try {
        const job = await invoke<GenerationJobStatus | null>("get_generation_job_status");
        await handleJob(job);
      } catch {
        // Keep the workspace stable even if a fallback status check fails.
      }
    }, 4000);

    return () => {
      cancelled = true;
      if (fallbackTimer) {
        window.clearInterval(fallbackTimer);
      }
      void unlistenPromise?.then((unlisten) => unlisten());
    };
  }, [settingsTick, selectedCampaignId]);

  useEffect(() => {
    let unlistenPromise: Promise<() => void> | undefined;
    unlistenPromise = listen<SendProgressEvent>("send-progress", (event) => {
      const ev = event.payload;
      setSendProgress(ev);
      if (ev.done) {
        setIsSending(false);
        setSendStatus(
          ev.error
            ? `Send failed: ${ev.error}`
            : `Sent ${ev.sent_count} of ${ev.total_count}${ev.failed_count > 0 ? `, ${ev.failed_count} failed` : ""}.`,
        );
        refreshData({ silent: true });
        if (String(selectedCampaignIdRef.current) !== "all") {
          loadCampaignSendStatus(Number(selectedCampaignIdRef.current));
        }
      } else if (ev.status === "sending" || ev.status === "sent" || ev.status === "failed") {
        setSendStatus(
          `Sending ${ev.client_name ?? "..."}  (${ev.sent_count + ev.failed_count + 1} of ${ev.total_count})`,
        );
      } else if (ev.status === "error") {
        setIsSending(false);
        setSendStatus(`Error: ${ev.error ?? "Unknown error"}`);
      }
    });
    return () => {
      void unlistenPromise?.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (activeStage !== "review" || reviewSection !== "drafts") return;
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "j" || e.key === "ArrowRight") { e.preventDefault(); goToNeighbor(1); }
      else if (e.key === "k" || e.key === "ArrowLeft") { e.preventDefault(); goToNeighbor(-1); }
      else if (e.key === "a" && selectedDraft && !busy) { e.preventDefault(); saveDraft(selectedDraft, "approved"); }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activeStage, reviewSection, selectedDraft, busy, selectedDraftIndex, filteredDrafts, pageSize]);

  async function loadCampaignSendStatus(campaignId: number) {
    if (!campaignId || isNaN(campaignId)) {
      setCampaignSendStatus(null);
      return;
    }
    try {
      const result = await invoke<CampaignSendStatus>("get_campaign_send_status", {
        payload: { campaign_id: campaignId },
      });
      setCampaignSendStatus(result);
      if (result.scheduled_at) {
        setScheduledAt(
          new Date(result.scheduled_at + "Z").toLocaleString("sv-SE", { hour12: false }).slice(0, 16),
        );
      } else {
        setScheduledAt("");
      }
    } catch {
      setCampaignSendStatus(null);
    }
  }

  useEffect(() => {
    if (selectedCampaignId !== "all") {
      loadCampaignSendStatus(Number(selectedCampaignId));
    } else {
      setCampaignSendStatus(null);
    }
  }, [selectedCampaignId]);

  async function sendNow() {
    if (!selectedCampaign) return;
    const confirmed = window.confirm(
      `Send all approved drafts for "${selectedCampaign.name}" now? This will email every approved recipient immediately.`,
    );
    if (!confirmed) return;
    setIsSending(true);
    setSendProgress(null);
    setSendStatus("Connecting to mail server...");
    try {
      await invoke("start_send_campaign_drafts", {
        payload: { campaign_id: selectedCampaign.id },
      });
    } catch (e) {
      setIsSending(false);
      setSendStatus(`Could not start send: ${String(e)}`);
    }
  }

  async function saveSchedule() {
    if (!selectedCampaign || !scheduledAt) return;
    try {
      const utcIso = new Date(scheduledAt).toISOString().slice(0, 19);
      await invoke("schedule_campaign_send", {
        payload: { campaign_id: selectedCampaign.id, scheduled_at: utcIso },
      });
      setShowScheduler(false);
      setSendStatus(
        `Scheduled for ${new Date(scheduledAt).toLocaleString()}. The app must be running at that time.`,
      );
      loadCampaignSendStatus(selectedCampaign.id);
    } catch (e) {
      setSendStatus(`Could not schedule: ${String(e)}`);
    }
  }

  async function cancelSchedule() {
    if (!selectedCampaign) return;
    try {
      await invoke("schedule_campaign_send", {
        payload: { campaign_id: selectedCampaign.id, scheduled_at: null },
      });
      setScheduledAt("");
      setShowScheduler(false);
      setSendStatus("Scheduled send cancelled.");
      loadCampaignSendStatus(selectedCampaign.id);
    } catch (e) {
      setSendStatus(`Could not cancel schedule: ${String(e)}`);
    }
  }

  async function autoGenerateDrafts() {
    if (!campaignBrief.trim()) {
      setStatus("Add a brief for the agent before generating drafts.");
      return;
    }

    setBusy(true);
    setStatus("Starting the writing agent...");
    const resolvedCampaignName = campaignName.trim() || buildRoundNameFromBrief(campaignBrief);
    try {
      const result = await invoke<GenerationJobStatus>(
        "start_generate_drafts",
        {
          payload: {
            model,
            template_id: null,
            max_clients: batchSize,
            campaign_name: resolvedCampaignName,
            campaign_goal: campaignBrief.trim(),
            call_to_action: callToAction.trim() || null,
            extra_context: null,
            use_agent_pipeline: useAgentPipeline,
          },
        },
      );
      setGenerationJob(result);
      changeCampaignFocus(String(result.campaign_id));
      setStatus(`Generation started for ${result.total_count} contacts.`);
      onStageChange("review");
    } catch (error) {
      setStatus(`Draft preparation failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function startNewRound() {
    setCampaignName("");
    setCampaignBrief("");
    setCallToAction("");
    changeCampaignFocus("all");
    setStatus("New round ready. Add the brief you want the agent to work from.");
    onStageChange("campaign");
  }

  async function saveDraft(draft: DraftLocalState, nextStatus: string) {
    setBusy(true);
    try {
      await invoke("update_draft", {
        payload: {
          draft_id: draft.id,
          subject: draft.subject,
          body: draft.body,
          status: nextStatus,
        },
      });
      setStatus(`${draft.client_name}'s draft was updated.`);
      setDirtyDraftIds((previous) => previous.filter((id) => id !== draft.id));
      await refreshData();
    } catch (error) {
      setStatus(`Could not update ${draft.client_name}'s draft: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function regenerateDraft(draft: DraftLocalState, instruction?: string) {
    setBusy(true);
    setStatus(`Refreshing ${draft.client_name}'s draft...`);
    try {
      await invoke<DraftRecord>("regenerate_draft", {
        payload: {
          draft_id: draft.id,
          instruction,
          model,
        },
      });
      setStatus(`${draft.client_name}'s draft was refreshed.`);
      setDirtyDraftIds((previous) => previous.filter((id) => id !== draft.id));
      await refreshData();
    } catch (error) {
      setStatus(`Could not refresh ${draft.client_name}'s draft: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function updateLocalDraft(id: number, patch: Partial<DraftLocalState>) {
    setDirtyDraftIds((previous) => (previous.includes(id) ? previous : [...previous, id]));
    setDrafts((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function openInMailApp(draft: DraftLocalState) {
    const normalizedBody = draft.body.replace(/\r?\n/g, "\r\n");
    const mailto = `mailto:${encodeURIComponent(draft.client_email)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(normalizedBody)}`;

    setBusy(true);
    setStatus(`Opening ${draft.client_name}'s message in the default mail app...`);
    try {
      await openUrl(mailto);
      setStatus(`Opened ${draft.client_name}'s draft in the default mail app.`);
    } catch (error) {
      setStatus(`Could not open the default mail app for ${draft.client_name}: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteDraft(draft: DraftLocalState) {
    const confirmed = window.confirm(
      `Delete ${draft.client_name}'s draft? This will also remove its export and send history.`,
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setStatus(`Deleting ${draft.client_name}'s draft...`);
    try {
      await invoke("delete_draft", {
        payload: {
          draft_id: draft.id,
        },
      });
      setDirtyDraftIds((previous) => previous.filter((id) => id !== draft.id));
      setSelectedDraftId(null);
      await refreshData();
      setStatus(`${draft.client_name}'s draft was deleted.`);
    } catch (error) {
      setStatus(`Could not delete ${draft.client_name}'s draft: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteCurrentRound() {
    if (!selectedCampaign || selectedCampaignId === "all") {
      setStatus("Choose a specific round before deleting it.");
      return;
    }

    const confirmed = window.confirm(
      `Delete the round "${selectedCampaign.name}" and all drafts inside it? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setStatus(`Deleting ${selectedCampaign.name}...`);
    try {
      await invoke("delete_campaign", {
        payload: {
          campaign_id: selectedCampaign.id,
        },
      });
      changeCampaignFocus("all");
      setSelectedDraftId(null);
      await refreshData();
      setStatus(`${selectedCampaign.name} was deleted.`);
    } catch (error) {
      setStatus(`Could not delete ${selectedCampaign.name}: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function bulkApproveDrafts() {
    const campaignFilter = selectedCampaignId === "all" ? null : Number(selectedCampaignId);
    const count = filteredDrafts.filter((d) => d.status === "review_required").length;
    if (count === 0) {
      setStatus("No drafts in the current view need approval.");
      return;
    }
    const confirmed = window.confirm(
      `Approve all ${count} draft${count !== 1 ? "s" : ""} currently marked as "Needs review"? You can still edit and revoke approval afterwards.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setStatus("Approving all drafts…");
    try {
      const result = await invoke<{ approved_count: number }>("bulk_approve_drafts", {
        payload: { campaign_id: campaignFilter },
      });
      setStatus(`${result.approved_count} draft${result.approved_count !== 1 ? "s" : ""} approved.`);
      await refreshData({ silent: true });
    } catch (e) {
      setStatus(`Bulk approve failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAllRounds() {
    const confirmed = window.confirm(
      "Delete all rounds and every draft currently stored in review? This cannot be undone.",
    );
    if (!confirmed) {
      return;
    }

    setResettingRounds(true);
    setStatus("Deleting all rounds...");
    try {
      await invoke("reset_workspace_data", {
        payload: {
          clear_campaigns: true,
          clear_clients: false,
        },
      });
      changeCampaignFocus("all");
      setSelectedDraftId(null);
      await refreshData();
      setStatus("All rounds were deleted.");
    } catch (error) {
      setStatus(`Could not delete all rounds: ${String(error)}`);
    } finally {
      setResettingRounds(false);
    }
  }

  async function exportDrafts(format: "xlsx" | "csv") {
    if (filteredDrafts.length === 0) {
      setStatus("There are no drafts in the current view to export.");
      return;
    }

    const exportRows = filteredDrafts.map((draft) => ({
      DraftId: draft.id,
      ClientName: draft.client_name,
      Company: draft.client_company,
      ClientEmail: draft.client_email,
      Industry: draft.client_industry,
      MessageRule: draft.template_name,
      ReviewStatus: draft.status,
      ReviewNote: draft.generation_label,
      Subject: draft.subject,
      Body: draft.body,
      CreatedAt: draft.created_at,
    }));

    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Drafts");

    const fileName = `mail_drafts_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${format}`;
    XLSX.writeFile(workbook, fileName, {
      bookType: format,
    });

    try {
      await invoke("mark_exported_drafts", {
        payload: {
          campaign_id: null,
          draft_ids: filteredDrafts.map((draft) => draft.id),
          format,
          file_name: fileName,
        },
      });
    } catch (error) {
      setStatus(`Drafts were exported, but the history entry could not be recorded: ${String(error)}`);
      return;
    }

    setStatus(`Exported ${filteredDrafts.length} drafts to ${fileName}.`);
    await refreshData();
  }

  function goToNeighbor(offset: number) {
    if (selectedDraftIndex < 0) {
      return;
    }
    const nextDraft = filteredDrafts[selectedDraftIndex + offset];
    if (!nextDraft) {
      return;
    }
    setSelectedDraftId(nextDraft.id);
    const nextIndex = selectedDraftIndex + offset;
    const nextPage = Math.floor(nextIndex / pageSize) + 1;
    setCurrentPage(nextPage);
  }

  return (
    <>
      <div className="panel stage-hero executive-stage-hero">
        <div className="stage-hero-row">
          <div>
            <div className="eyebrow">{activeStage === "campaign" ? "Agent drafting" : "Review workspace"}</div>
            <h2>{activeStage === "campaign" ? "Create a round in one brief" : "Work through one draft at a time"}</h2>
            <p>
              {activeStage === "campaign"
                ? "Describe the opportunity once. The writing agent will combine that brief with sender and recipient details automatically."
                : "Choose the round you want to inspect, then review, approve, rewrite, or export without losing your place."}
            </p>
          </div>
          <div className="stage-chip-stack">
            <div className="panel-chip">{selectedCampaign ? selectedCampaign.name : "All rounds"}</div>
            <div className="stage-mini-note">{queueHeadline}</div>
          </div>
        </div>

        {generationJob && generationJob.status === "running" ? (
          <div className="generation-progress-card embedded executive-progress-card">
            <div className="panel-header">
              <div>
                <h2>Agent is preparing drafts</h2>
                <p>
                  {generationJob.current_client_name
                    ? `Currently writing for ${generationJob.current_client_name}. New drafts will appear here as they are ready.`
                    : "The agent is working through your selected contacts now."}
                </p>
              </div>
              <div className="progress-number">{generationPercent}%</div>
            </div>
            <div className="progress-track large soft-track">
              <div className="progress-fill office-fill" style={{ width: `${generationPercent}%` }} />
            </div>
            <div className="generation-stats calm-stats">
              <span>{generationJob.generated_count} generated</span>
              <span>{generationJob.flagged_count} flagged</span>
              <span>{generationJob.failed_count} failed</span>
              <span>{generationJob.total_count} total</span>
            </div>
          </div>
        ) : null}

        <p className="status idle">{status}</p>
      </div>

      {activeStage === "campaign" ? (
        <div className="agent-create-layout">
          <section className="panel agent-brief-panel">
            <div className="panel-header">
              <div>
                <h2>What should this round say?</h2>
                <p>Keep it simple. The agent already knows who the sender is and who the recipients are.</p>
              </div>
            </div>

            <div className="form-grid">
              <label className="mapping-row">
                <span>Round name</span>
                <input
                  value={campaignName}
                  onChange={(event) => setCampaignName(event.target.value)}
                  placeholder="Optional. Leave blank to auto-name this round."
                />
              </label>
              <label className="mapping-row">
                <span>Desired next step</span>
                <input
                  value={callToAction}
                  onChange={(event) => setCallToAction(event.target.value)}
                  placeholder="Optional. Example: ask for a short call next week."
                />
              </label>
              <label className="mapping-row">
                <span>Instructions for the writing agent</span>
                <textarea
                  rows={9}
                  value={campaignBrief}
                  onChange={(event) => setCampaignBrief(event.target.value)}
                  placeholder="Example: We are inviting retail operators to consider WorkPlace for flexible office space. Keep it persuasive, direct, and premium. Mention that the space is ready to tour and suited for teams that need a polished client-facing environment."
                />
              </label>
            </div>

            <div className="panel-actions wrap">
              <button type="button" className="primary-button" onClick={autoGenerateDrafts} disabled={busy || isGenerating}>
                {busy || isGenerating ? "Starting agent..." : "Generate drafts"}
              </button>
              <button type="button" className="secondary-button" onClick={startNewRound} disabled={busy || isGenerating}>
                Clear brief
              </button>
              <label className="agent-pipeline-toggle">
                <input
                  type="checkbox"
                  checked={useAgentPipeline}
                  onChange={(e) => setUseAgentPipeline(e.target.checked)}
                  disabled={busy || isGenerating}
                />
                <span>Agent pipeline</span>
                <span className="agent-pipeline-hint">(planner → writer, slower but higher quality)</span>
              </label>
            </div>
          </section>

          <aside className="panel agent-side-panel">
            <div className="agent-side-block">
              <div className="eyebrow">Agent mode</div>
              <h3>What the app uses automatically</h3>
              <ul className="agent-checklist">
                <li>Sender details from your brand profile</li>
                <li>Recipient name, company, industry, and email</li>
                <li>Best matching tone for the contact's industry</li>
                <li>Up to {batchSize} contacts in this round</li>
              </ul>
            </div>

            <div className="review-overview slim compact-overview">
              <div className="review-overview-card">
                <span>Contacts ready</span>
                <strong>{summary.total_clients}</strong>
                <p>Available for the next round.</p>
              </div>
              <div className="review-overview-card">
                <span>Waiting for review</span>
                <strong>{summary.review_required}</strong>
                <p>Already generated and ready for approval.</p>
              </div>
            </div>

            <div className="notice-card calm">
              <strong>Executive workflow</strong>
              <p>
                You only provide the message brief. The app handles structure, personalization, and queueing so you
                can stay focused on reviewing the finished drafts.
              </p>
            </div>
          </aside>
        </div>
      ) : null}

      {activeStage === "review" ? <div className="panel review-shell-panel">
        <div className="panel-header">
          <div>
            <h2>Review workspace</h2>
            <p>Use the queue on the left, then review and approve the selected message on the right.</p>
          </div>
          <div className="panel-chip">
            {filteredDrafts.length} match{filteredDrafts.length === 1 ? "" : "es"}
          </div>
        </div>

        <div className="panel-actions wrap review-shell-actions">
          <button
            type="button"
            className="primary-button approve-all-button"
            onClick={bulkApproveDrafts}
            disabled={busy || filteredDrafts.filter((d) => d.status === "review_required").length === 0}
            title="Approve all drafts currently marked as Needs review"
          >
            Approve all ({filteredDrafts.filter((d) => d.status === "review_required").length})
          </button>
          <button type="button" className="secondary-button" onClick={() => exportDrafts("xlsx")} disabled={busy}>
            Download Excel
          </button>
          <button type="button" className="secondary-button" onClick={() => exportDrafts("csv")} disabled={busy}>
            Download CSV
          </button>
          <button type="button" className="secondary-button" onClick={() => refreshData()} disabled={busy}>
            Refresh queue
          </button>
          <button
            type="button"
            className="secondary-button destructive-button"
            onClick={deleteCurrentRound}
            disabled={busy || selectedCampaignId === "all" || !selectedCampaign}
          >
            Delete round
          </button>
          <button
            type="button"
            className="secondary-button destructive-button"
            onClick={deleteAllRounds}
            disabled={busy || resettingRounds || campaigns.length === 0}
          >
            {resettingRounds ? "Deleting rounds..." : "Delete all rounds"}
          </button>
          <button type="button" className="secondary-button" onClick={startNewRound} disabled={busy || isGenerating}>
            Start another round
          </button>
          <span className="keyboard-hint">j/k navigate · a approve</span>
        </div>

        {selectedCampaignId !== "all" && selectedCampaign && (
          <div className="send-delivery-panel">
            <div className="send-delivery-header">
              <div>
                <div className="eyebrow">Send &amp; schedule</div>
                <h3>Deliver "{selectedCampaign.name}"</h3>
                {campaignSendStatus && (
                  <p className="send-meta-line">
                    <span className="send-stat">{campaignSendStatus.approved_count} approved &amp; ready</span>
                    {campaignSendStatus.sent_count > 0 && (
                      <span className="send-stat sent">{campaignSendStatus.sent_count} already sent</span>
                    )}
                    {campaignSendStatus.scheduled_at && (
                      <span className="send-stat scheduled">
                        Scheduled: {new Date(campaignSendStatus.scheduled_at + "Z").toLocaleString()}
                      </span>
                    )}
                  </p>
                )}
              </div>
              <div className="send-action-cluster">
                <button
                  type="button"
                  className="primary-button send-now-button"
                  onClick={sendNow}
                  disabled={isSending || busy || !campaignSendStatus || campaignSendStatus.approved_count === 0}
                >
                  {isSending ? "Sending..." : "Send all approved now"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setShowScheduler((v) => !v)}
                  disabled={isSending}
                >
                  {campaignSendStatus?.scheduled_at ? "Change schedule" : "Schedule send"}
                </button>
              </div>
            </div>

            {isSending && sendProgress && (
              <div className="send-progress-track">
                <div className="send-progress-bar-wrap">
                  <div
                    className="send-progress-bar"
                    style={{
                      width: `${sendProgress.total_count > 0 ? Math.round(((sendProgress.sent_count + sendProgress.failed_count) / sendProgress.total_count) * 100) : 0}%`,
                    }}
                  />
                </div>
                <span className="send-progress-label">
                  {sendProgress.sent_count + sendProgress.failed_count} / {sendProgress.total_count}
                  {sendProgress.client_name ? ` — ${sendProgress.client_name}` : ""}
                </span>
              </div>
            )}

            {showScheduler && (
              <div className="schedule-form">
                <div className="schedule-form-inner">
                  <label className="mapping-row">
                    <span>Send date &amp; time (your local time)</span>
                    <input
                      type="datetime-local"
                      value={scheduledAt}
                      min={new Date(Date.now() + 60000).toLocaleString("sv-SE", { hour12: false }).slice(0, 16)}
                      onChange={(e) => setScheduledAt(e.target.value)}
                    />
                  </label>
                  <div className="schedule-form-actions">
                    <button
                      type="button"
                      className="primary-button"
                      onClick={saveSchedule}
                      disabled={!scheduledAt}
                    >
                      Confirm schedule
                    </button>
                    {campaignSendStatus?.scheduled_at && (
                      <button
                        type="button"
                        className="secondary-button destructive-button"
                        onClick={cancelSchedule}
                      >
                        Cancel schedule
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setShowScheduler(false)}
                    >
                      Close
                    </button>
                  </div>
                </div>
                <p className="send-schedule-note">
                  The app must be open at the scheduled time for automatic sending to work.
                </p>
              </div>
            )}

            {sendStatus && <p className="send-status-line">{sendStatus}</p>}
          </div>
        )}

        <div className="section-tabs">
          <button
            type="button"
            className={reviewSection === "drafts" ? "filter-chip active" : "filter-chip"}
            onClick={() => setReviewSection("drafts")}
          >
            Draft queue
          </button>
          <button
            type="button"
            className={reviewSection === "history" ? "filter-chip active" : "filter-chip"}
            onClick={() => setReviewSection("history")}
          >
            History
          </button>
        </div>

        {reviewSection === "drafts" ? <div className="review-toolbar executive-review-toolbar">
          <div className="filter-row">
            {FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={statusFilter === filter.value ? "filter-chip active" : "filter-chip"}
                onClick={() => {
                  setStatusFilter(filter.value);
                  setCurrentPage(1);
                }}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div className="review-toolbar-grid">
            <label className="mapping-row">
              <span>Round to view</span>
              <select
                value={selectedCampaignId}
                onChange={(event) => {
                  changeCampaignFocus(event.target.value);
                  setCurrentPage(1);
                }}
              >
                <option value="all">All rounds</option>
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={String(campaign.id)}>
                    {campaign.name} ({campaign.draft_count})
                  </option>
                ))}
              </select>
            </label>
            <label className="mapping-row">
              <span>Search drafts</span>
              <input
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setCurrentPage(1);
                }}
                placeholder="Search by client, company, email, subject, or industry"
              />
            </label>
            <label className="mapping-row">
              <span>Rows per page</span>
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  setCurrentPage(1);
                }}
              >
                <option value="10">10</option>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </label>
          </div>
          <div className="review-toolbar-note">
            <strong>{queueHeadline}</strong>
            <span>
              {selectedCampaign ? `${selectedCampaign.draft_count} drafts in this round.` : "Showing every round currently stored."}
            </span>
          </div>
        </div> : null}

        {reviewSection === "drafts" && filteredDrafts.length === 0 ? (
          <div className="empty-state">
            <h3>{isGenerating ? "Draft generation is in progress" : "No drafts in this view"}</h3>
            <p>
              {isGenerating
                ? "Stay on this page. New drafts will appear here automatically as the round is generated."
                : "Prepare drafts from contacts, or change the round filter to inspect another part of the queue."}
            </p>
          </div>
        ) : null}

        {reviewSection === "drafts" && filteredDrafts.length > 0 ? (
          <div className="review-layout">
            <aside className="review-list">
              <div className="review-list-header">
                <strong>Draft queue</strong>
                <span>
                  Page {currentPage} of {totalPages}
                </span>
              </div>

              <div className="draft-list">
                {pagedDrafts.map((draft) => (
                  <button
                    key={draft.id}
                    type="button"
                    className={selectedDraft?.id === draft.id ? "draft-row active" : "draft-row"}
                    onClick={() => setSelectedDraftId(draft.id)}
                  >
                    <div className="draft-row-head">
                      <strong>{draft.client_name}</strong>
                      <span className={draft.status === "approved" ? "mini-pill success" : "mini-pill"}>
                        {draft.status.replace("_", " ")}
                      </span>
                    </div>
                    <p>{draft.client_company ? `${draft.client_company} · ` : ""}{draft.client_email}</p>
                    <small>{draft.subject || "No subject yet"}</small>
                    {draft.needs_attention ? <em>Needs closer review</em> : null}
                  </button>
                ))}
              </div>

              <div className="review-list-footer">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  disabled={currentPage === 1}
                >
                  Previous page
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next page
                </button>
              </div>
            </aside>

            <section className="review-detail">
              {selectedDraft ? (
                <>
                  <div className="panel-header">
                    <div>
                      <h2>{selectedDraft.client_name}</h2>
                      <p>{selectedDraft.client_company ? `${selectedDraft.client_company} · ` : ""}{selectedDraft.client_industry}</p>
                    </div>
                    <div className={selectedDraft.status === "approved" ? "panel-chip success" : "panel-chip"}>
                      {selectedDraft.status.replace("_", " ")}
                    </div>
                  </div>

                  <div className="selected-draft-banner">
                    <div>
                      <span>Recipient</span>
                      <strong>{selectedDraft.client_email}</strong>
                    </div>
                    <div>
                      <span>Round</span>
                      <strong>{selectedDraft.campaign_name}</strong>
                    </div>
                    <div>
                      <span>Writing style</span>
                      <strong>{selectedDraft.template_name}</strong>
                    </div>
                  </div>

                  <div className="identity-grid">
                    <div className="identity-item">
                      <span>Email</span>
                      <strong>{selectedDraft.client_email}</strong>
                    </div>
                    <div className="identity-item">
                      <span>Writing style</span>
                      <strong>{selectedDraft.template_name}</strong>
                    </div>
                    <div className="identity-item">
                      <span>Created</span>
                      <strong>{selectedDraft.created_at}</strong>
                    </div>
                  </div>

                  <div className={selectedDraft.needs_attention ? "notice-card warning" : "notice-card calm"}>
                    <strong>{selectedDraft.generation_mode === "ollama" ? "Personalization status" : "Review required"}</strong>
                    <p>{selectedDraft.generation_label}</p>
                  </div>

                  <div className="detail-navigation">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => goToNeighbor(-1)}
                      disabled={selectedDraftIndex <= 0}
                    >
                      Previous draft
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => goToNeighbor(1)}
                      disabled={selectedDraftIndex < 0 || selectedDraftIndex >= filteredDrafts.length - 1}
                    >
                      Next draft
                    </button>
                  </div>

                  <div className="form-grid">
                    <label className="mapping-row">
                      <span>Subject</span>
                      <input
                        value={selectedDraft.subject}
                        onChange={(event) => updateLocalDraft(selectedDraft.id, { subject: event.target.value })}
                      />
                    </label>
                    <label className="mapping-row">
                      <span>Message</span>
                      <textarea
                        rows={10}
                        value={selectedDraft.body}
                        onChange={(event) => updateLocalDraft(selectedDraft.id, { body: event.target.value })}
                      />
                    </label>
                    <label className="mapping-row">
                      <span>Rewrite request</span>
                      <input
                        placeholder="Example: shorten this and make it more formal"
                        value={selectedDraft.fine_tune_instruction}
                        onChange={(event) =>
                          updateLocalDraft(selectedDraft.id, { fine_tune_instruction: event.target.value })
                        }
                      />
                    </label>
                  </div>

                  <div className="panel-actions wrap">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => saveDraft(selectedDraft, "review_required")}
                      disabled={busy}
                    >
                      Save edits
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => saveDraft(selectedDraft, "approved")}
                      disabled={busy}
                    >
                      Approve draft
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => saveDraft(selectedDraft, "refine_requested")}
                      disabled={busy}
                    >
                      Mark for rewrite
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => regenerateDraft(selectedDraft)}
                      disabled={busy}
                    >
                      Regenerate
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => regenerateDraft(selectedDraft, selectedDraft.fine_tune_instruction)}
                      disabled={busy || !selectedDraft.fine_tune_instruction.trim()}
                    >
                      Apply rewrite request
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => openInMailApp(selectedDraft)}
                      disabled={busy || !selectedDraft.client_email.trim()}
                    >
                      Open in mail app
                    </button>
                    <button
                      type="button"
                      className="secondary-button destructive-button"
                      onClick={() => deleteDraft(selectedDraft)}
                      disabled={busy}
                    >
                      Delete draft
                    </button>
                  </div>

                  {contactHistory.length > 1 && (
                    <div className="contact-history-section">
                      <button
                        type="button"
                        className="contact-history-toggle"
                        onClick={() => setShowContactHistory((v) => !v)}
                      >
                        <span>Previous emails to {selectedDraft.client_email}</span>
                        <span className="contact-history-count">{contactHistory.length - 1} earlier</span>
                        <span className="contact-history-chevron">{showContactHistory ? "▲" : "▼"}</span>
                      </button>
                      {showContactHistory && (
                        <div className="contact-history-list">
                          {contactHistory.slice(1).map((h, i) => (
                            <div key={i} className="contact-history-item">
                              <div className="contact-history-meta">
                                <span className="contact-history-campaign">{h.campaign_name}</span>
                                <span className={`mini-pill${h.status === "sent" ? " success" : ""}`}>{h.status.replace("_", " ")}</span>
                                <span className="contact-history-date">{h.created_at.slice(0, 10)}</span>
                              </div>
                              <div className="contact-history-subject">{h.subject}</div>
                              <p className="contact-history-preview">{h.body_preview}{h.body_preview.length >= 200 ? "…" : ""}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : null}
            </section>
          </div>
        ) : null}
      </div> : null}

      {activeStage === "review" && reviewSection === "history" ? <div className="panel">
        <div className="panel-header">
          <div>
            <h2>History</h2>
            <p>Recent audit events for downloads and future send activity.</p>
          </div>
        </div>
        {history.length === 0 ? (
          <div className="empty-state">
            <h3>No history yet</h3>
            <p>Exports and future send events will appear here so the team can see what happened and when.</p>
          </div>
        ) : (
          <div className="preview-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Client</th>
                  <th>Email</th>
                  <th>Event</th>
                  <th>Detail</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 20).map((item) => (
                  <tr key={item.id}>
                    <td>{item.happened_at}</td>
                    <td>{item.client_name}</td>
                    <td>{item.client_email}</td>
                    <td>{item.event_type}</td>
                    <td>{item.detail || "-"}</td>
                    <td>{item.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div> : null}
    </>
  );
}
