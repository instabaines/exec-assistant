import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type Settings = {
  sender_name: string;
  sender_company: string;
  model: string;
  default_system_prompt: string;
  sender_position: string;
};

type Props = {
  model: string;
};

const STARTERS = [
  "What needs my attention today?",
  "Which deals are stalling?",
  "Summarize my open tasks by priority.",
  "Who should I follow up with this week?",
  "What did we discuss in recent meetings?",
  "Draft a follow-up for my most stale deal.",
];

function deriveAssistantName(name: string, company: string): string {
  if (company.trim()) return `${company.trim()} Assistant`;
  if (name.trim()) return `${name.trim().split(" ")[0]}'s Assistant`;
  return "Your Assistant";
}

function friendlyError(assistantName: string): string {
  return `I'm not able to reach the AI engine right now. Please make sure Ollama is running and try again in a moment.\n\n— ${assistantName}`;
}

export function AssistantChat({ model }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [assistantName, setAssistantName] = useState("Your Assistant");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    invoke<Settings>("get_generation_settings")
      .then((s) => setAssistantName(deriveAssistantName(s.sender_name, s.sender_company)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    const userMsg: Message = { role: "user", content };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const reply = await invoke<string>("chat_workspace", {
        model,
        message: content,
        history: messages,
      });
      setMessages([...next, { role: "assistant", content: reply.trim() }]);
    } catch {
      setMessages([...next, { role: "assistant", content: friendlyError(assistantName) }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="chat-shell">
      <div className="chat-messages" role="log" aria-live="polite">
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">✦</div>
            <h3>{assistantName}</h3>
            <p>Ask anything about your workspace — tasks, deals, meetings, contacts, and outreach.</p>
            <div className="chat-starters">
              {STARTERS.map((s) => (
                <button key={s} type="button" className="chat-starter-chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble-row ${m.role}`}>
            {m.role === "assistant" && (
              <span className="chat-assistant-label">{assistantName}</span>
            )}
            <div className={`chat-bubble ${m.role}`}>
              <MessageContent content={m.content} />
            </div>
          </div>
        ))}

        {loading && (
          <div className="chat-bubble-row assistant">
            <span className="chat-assistant-label">{assistantName}</span>
            <div className="chat-bubble assistant loading">
              <span className="chat-typing-dot" />
              <span className="chat-typing-dot" />
              <span className="chat-typing-dot" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-area">
        {messages.length > 0 && (
          <button
            type="button"
            className="chat-clear-btn"
            onClick={() => setMessages([])}
            title="Clear conversation"
          >
            Clear
          </button>
        )}
        <div className="chat-input-row">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={`Ask ${assistantName}… (Enter to send, Shift+Enter for new line)`}
            rows={2}
            disabled={loading}
            autoFocus
          />
          <button
            type="button"
            className="chat-send-btn"
            onClick={() => send()}
            disabled={loading || !input.trim()}
            aria-label="Send"
          >
            {loading ? "…" : "↑"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="chat-message-content">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ") || trimmed.startsWith("• ")) {
          return <li key={i}>{renderInline(trimmed.slice(2))}</li>;
        }
        if (trimmed === "") return <br key={i} />;
        return <p key={i}>{renderInline(trimmed)}</p>;
      })}
    </div>
  );
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  );
}
