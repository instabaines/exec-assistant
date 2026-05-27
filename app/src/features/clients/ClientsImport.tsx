import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";

type ClientField = "name" | "email" | "industry" | "company" | "last_contacted_at";
type Mapping = Record<ClientField, string>;
type ParsedRow = Record<string, string>;
type StoredClient = {
  id: number;
  name: string;
  email: string;
  industry: string;
  company: string;
  last_contacted_at: string;
  updated_at: string;
};

const FIELD_META: Array<{ key: ClientField; label: string; required: boolean }> = [
  { key: "name", label: "Client Name", required: true },
  { key: "email", label: "Email", required: true },
  { key: "industry", label: "Industry", required: true },
  { key: "company", label: "Company", required: false },
  { key: "last_contacted_at", label: "Last Contacted", required: false },
];

const EMPTY_MAPPING: Mapping = {
  name: "",
  email: "",
  industry: "",
  company: "",
  last_contacted_at: "",
};

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function suggestMapping(headers: string[]): Mapping {
  const normalized = headers.map((header) => ({
    original: header,
    normalized: normalizeHeader(header),
  }));

  const pick = (terms: string[]): string => {
    const match = normalized.find((entry) => terms.some((term) => entry.normalized.includes(term)));
    return match ? match.original : "";
  };

  return {
    name: pick(["client name", "name", "full name", "contact name"]),
    email: pick(["email", "email address", "mail"]),
    industry: pick(["industry", "segment", "vertical"]),
    company: pick(["company", "organization", "business"]),
    last_contacted_at: pick(["last contacted", "last contact", "contacted", "last touch"]),
  };
}

async function parseWorkbook(file: File): Promise<{ headers: string[]; rows: ParsedRow[] }> {
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error("No sheets found in the selected Excel file.");
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<ParsedRow>(sheet, {
    defval: "",
  });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    headers,
    rows: rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value ?? "").trim()])),
    ),
  };
}

type Props = {
  onContinue?: () => void;
  onOpenContact?: (clientId: number) => void;
};

export function ClientsImport({ onContinue, onOpenContact }: Props) {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  const [status, setStatus] = useState("Drop in the spreadsheet your team already uses and we will prepare the contact list.");
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const [storedClients, setStoredClients] = useState<StoredClient[]>([]);
  const [storedSearch, setStoredSearch] = useState("");
  const [deletingClientId, setDeletingClientId] = useState<number | null>(null);
  const [resettingContacts, setResettingContacts] = useState(false);

  async function refreshStoredClients() {
    try {
      const clients = await invoke<StoredClient[]>("list_clients");
      setStoredClients(clients);
    } catch {
      setStoredClients([]);
    }
  }

  useEffect(() => {
    refreshStoredClients();
  }, []);

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setError("");
    setStatus("Reading spreadsheet...");

    try {
      const parsed = await parseWorkbook(file);
      setFileName(file.name);
      setHeaders(parsed.headers);
      setRows(parsed.rows);
      setMapping(suggestMapping(parsed.headers));
      setStatus(`Loaded ${parsed.rows.length} contacts from ${file.name}.`);
    } catch (parseError) {
      setFileName("");
      setHeaders([]);
      setRows([]);
      setMapping(EMPTY_MAPPING);
      setError(`Import failed: ${String(parseError)}`);
      setStatus("Choose another file and try again.");
    }
  }

  const requiredFields = useMemo(() => FIELD_META.filter((field) => field.required), []);

  const requiredMappingMissing = useMemo(
    () => requiredFields.some((field) => !mapping[field.key]),
    [mapping, requiredFields],
  );

  const validationSummary = useMemo(() => {
    if (!rows.length) {
      return { ready: false, validRows: 0, invalidRows: 0 };
    }
    if (requiredMappingMissing) {
      return { ready: false, validRows: 0, invalidRows: rows.length };
    }

    let validRows = 0;
    for (const row of rows) {
      const hasAllRequired = requiredFields.every((field) => {
        const column = mapping[field.key];
        return Boolean(column && row[column]?.trim());
      });
      if (hasAllRequired) {
        validRows += 1;
      }
    }

    return {
      ready: true,
      validRows,
      invalidRows: rows.length - validRows,
    };
  }, [mapping, requiredFields, requiredMappingMissing, rows]);

  async function saveToLocalStore(): Promise<boolean> {
    if (!fileName) {
      setSaveState("error");
      setSaveMessage("Choose a spreadsheet before saving contacts.");
      return false;
    }
    if (requiredMappingMissing) {
      setSaveState("error");
      setSaveMessage("Match the required columns before saving contacts.");
      return false;
    }

    setSaveState("saving");
    setSaveMessage("Saving contacts...");
    try {
      const result = await invoke<{ imported_count: number; skipped_count: number; profile_id: number }>(
        "save_imported_clients",
        {
          payload: {
            source_file_name: fileName,
            profile_name: "Default Import Profile",
            mapping,
            rows,
          },
        },
      );
      setSaveState("success");
      setSaveMessage(
        `Saved ${result.imported_count} contacts. ${result.skipped_count > 0 ? `${result.skipped_count} duplicates were skipped.` : "No duplicates were found."}`,
      );
      await refreshStoredClients();
      return true;
    } catch (saveError) {
      setSaveState("error");
      setSaveMessage(`Could not save contacts: ${String(saveError)}`);
      return false;
    }
  }

  async function saveAndContinue() {
    const saved = await saveToLocalStore();
    if (!saved) {
      return;
    }
    setSaveMessage("Contacts saved. Moving to the next step to create this outreach round.");
    onContinue?.();
  }

  const previewRows = rows.slice(0, 8);
  const filteredStoredClients = useMemo(() => {
    const query = storedSearch.trim().toLowerCase();
    if (!query) {
      return storedClients;
    }

    return storedClients.filter((client) =>
      [client.name, client.email, client.industry, client.company]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [storedClients, storedSearch]);

  async function handleDeleteClient(client: StoredClient) {
    const confirmed = window.confirm(
      `Delete ${client.name} and any drafts linked to this contact? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    setDeletingClientId(client.id);
    setSaveMessage("");
    try {
      await invoke("delete_client", {
        payload: {
          client_id: client.id,
        },
      });
      setStatus(`${client.name} was removed from local contacts.`);
      await refreshStoredClients();
    } catch (error) {
      setSaveState("error");
      setSaveMessage(`Could not delete ${client.name}: ${String(error)}`);
    } finally {
      setDeletingClientId(null);
    }
  }

  async function handleResetContacts() {
    const confirmed = window.confirm(
      "Delete all saved contacts and all linked drafts so you can start fresh? This cannot be undone.",
    );
    if (!confirmed) {
      return;
    }

    setResettingContacts(true);
    setSaveMessage("");
    try {
      await invoke("reset_workspace_data", {
        payload: {
          clear_campaigns: false,
          clear_clients: true,
        },
      });
      setStoredSearch("");
      setStatus("All contacts and linked drafts were removed.");
      await refreshStoredClients();
    } catch (error) {
      setSaveState("error");
      setSaveMessage(`Could not clear contacts: ${String(error)}`);
    } finally {
      setResettingContacts(false);
    }
  }

  return (
    <>
      <div className="panel hero-panel">
        <div className="panel-header">
          <div>
            <div className="eyebrow">Contacts</div>
            <h2>Bring in your contact spreadsheet</h2>
          </div>
          <div className="panel-chip">{rows.length} rows loaded</div>
        </div>
        <p>
          Upload the spreadsheet your team already uses, confirm the key columns once, and move directly into the outreach round workspace.
        </p>
        <label className="file-picker">
          <span>Choose Excel file</span>
          <input type="file" accept=".xlsx,.xls" onChange={onFileChange} />
        </label>
        <p className="status idle">{status}</p>
        {fileName ? <p className="status success">Current file: {fileName}</p> : null}
        {error ? <p className="status error">{error}</p> : null}
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Column check</h2>
            <p>We suggest the mapping automatically. Only adjust it if a column was guessed incorrectly.</p>
          </div>
          <div className={validationSummary.ready ? "panel-chip success" : "panel-chip"}>
            {validationSummary.ready ? "Ready to continue" : "Needs a quick review"}
          </div>
        </div>
        <div className="mapping-grid compact-grid">
          {FIELD_META.map((field) => (
            <label key={field.key} className="mapping-row">
              <span>
                {field.label}
                {field.required ? " *" : ""}
              </span>
              <select
                value={mapping[field.key]}
                onChange={(event) =>
                  setMapping((prev) => ({
                    ...prev,
                    [field.key]: event.target.value,
                  }))
                }
                disabled={headers.length === 0}
              >
                <option value="">Select column</option>
                {headers.map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Preview</h2>
            <p>
              {validationSummary.ready
                ? `${validationSummary.validRows} contacts are ready. ${validationSummary.invalidRows} row${validationSummary.invalidRows === 1 ? "" : "s"} still need required details.`
                : "Complete the required column matches to validate the file."}
            </p>
          </div>
        </div>

        {previewRows.length > 0 ? (
          <div className="preview-wrap">
            <table>
              <thead>
                <tr>
                  {headers.map((header) => (
                    <th key={header}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, rowIndex) => (
                  <tr key={`${rowIndex}-${row[headers[0]] ?? "row"}`}>
                    {headers.map((header) => (
                      <td key={`${rowIndex}-${header}`}>{row[header] || "-"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <h3>No contact preview yet</h3>
            <p>Once a spreadsheet is loaded, the first few rows will appear here for a quick confidence check.</p>
          </div>
        )}

        <div className="panel-actions">
          <button
            type="button"
            className="primary-button"
            onClick={saveAndContinue}
            disabled={saveState === "saving" || !validationSummary.ready}
          >
            Save contacts and open email creation
          </button>
        </div>
        {saveMessage ? <p className={`status ${saveState}`}>{saveMessage}</p> : null}
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>Stored contacts</h2>
            <p>Review the latest contact records already saved in the local database.</p>
          </div>
          <div className="stored-contacts-tools">
            <label className="mapping-row compact-inline-field">
              <span>Filter contacts</span>
              <input
                value={storedSearch}
                onChange={(event) => setStoredSearch(event.target.value)}
                placeholder="Search by name, email, company, or industry"
              />
            </label>
            <button
              type="button"
              className="secondary-button destructive-button"
              onClick={handleResetContacts}
              disabled={resettingContacts || storedClients.length === 0}
            >
              {resettingContacts ? "Clearing..." : "Delete all contacts"}
            </button>
            <div className="panel-chip">{filteredStoredClients.length} shown</div>
          </div>
        </div>

        {filteredStoredClients.length === 0 ? (
          <div className="empty-state">
            <h3>{storedClients.length === 0 ? "No saved contacts yet" : "No contacts match this filter"}</h3>
            <p>
              {storedClients.length === 0
                ? "Once you save a spreadsheet, the latest stored contacts will appear here for review."
                : "Try a broader search to bring more contacts back into view."}
            </p>
          </div>
        ) : (
          <div className="preview-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Industry</th>
                  <th>Company</th>
                  <th>Last Contacted</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredStoredClients.map((client) => (
                  <tr key={client.id}>
                    <td>
                      {onOpenContact ? (
                        <button type="button" className="contact-name-link" onClick={() => onOpenContact(client.id)}>
                          {client.name}
                        </button>
                      ) : client.name}
                    </td>
                    <td>{client.email}</td>
                    <td>{client.industry}</td>
                    <td>{client.company || "-"}</td>
                    <td>{client.last_contacted_at || "-"}</td>
                    <td>
                      <button
                        type="button"
                        className="table-action-button destructive"
                        onClick={() => handleDeleteClient(client)}
                        disabled={deletingClientId === client.id}
                      >
                        {deletingClientId === client.id ? "Deleting..." : "Delete"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
