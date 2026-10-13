"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  CircleCheck,
  Database,
  Eraser,
  LoaderCircle,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Panel } from "@/components/common/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "gatf-ask-history";
const MAX_STORED_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 2_000;
const TABLE_PREVIEW_ROWS = 20;

const SUGGESTIONS = [
  "Busiest hour last week?",
  "How many overnight cars this month?",
  "How far off was the last reconciliation?",
  "Average dwell on weekdays vs weekends?",
  "Which day had the highest peak occupancy?",
  "How many vehicles are in the lot right now?",
];

type QueryRecord = {
  tool: string;
  sql: string | null;
  rowCount: number | null;
  durationMs: number;
  truncated: boolean;
  isError: boolean;
};

type Table = { columns: string[]; rows: unknown[][] };

type ChatResponse = {
  id: string;
  answer: string;
  queries: QueryRecord[];
  data: Table | null;
  coverageChecked: boolean;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string;
  warnings: string[];
};

type UserMessage = { id: string; role: "user"; content: string; at: number };
type AssistantMessage = {
  id: string;
  role: "assistant";
  content: string;
  at: number;
  queries: QueryRecord[];
  data: Table | null;
  coverageChecked: boolean;
  warnings: string[];
  usage?: { inputTokens: number; outputTokens: number };
  stopReason?: string;
};
type ChatMessage = UserMessage | AssistantMessage;

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function loadHistory(): ChatMessage[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        typeof m.id === "string",
    ).map((m) =>
      m.role === "assistant"
        ? {
            ...m,
            queries: Array.isArray(m.queries) ? m.queries : [],
            warnings: Array.isArray(m.warnings) ? m.warnings : [],
            data: m.data ?? null,
            coverageChecked: m.coverageChecked === true,
          }
        : m,
    );
  } catch {
    return [];
  }
}

function saveHistory(messages: ChatMessage[]) {
  try {
    if (messages.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)));
  } catch {
    // Storage full / disabled (private mode): history just won't persist.
  }
}

function errorFor(status: number, body: unknown): string {
  const serverMsg =
    body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
      ? (body as { error: string }).error
      : null;
  switch (status) {
    case 401:
      return "Your session has expired. Sign in again to keep asking.";
    case 404:
      return "The assistant is turned off for this deployment.";
    case 429:
      return serverMsg ?? "You're asking too fast. Wait a few minutes and try again.";
    case 503:
      return serverMsg ?? "The assistant is not available right now.";
    default:
      return serverMsg ?? `The request failed (HTTP ${status}).`;
  }
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function AskChat({ model }: { model: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; retry: string | null } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // History lives only in this browser. Read after mount to avoid a hydration mismatch.
  useEffect(() => {
    const stored = loadHistory();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync from localStorage
    setMessages(stored);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) saveHistory(messages);
  }, [messages, loaded]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, pending, error]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string, opts: { retry?: boolean } = {}) => {
      const message = text.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!message || pending) return;

      // On retry the user turn is already the last message; don't duplicate it.
      const prior = opts.retry ? messages.slice(0, -1) : messages;
      const history = prior.map((m) => ({ role: m.role, content: m.content }));
      if (!opts.retry) {
        setMessages((ms) => [...ms, { id: newId(), role: "user", content: message, at: Date.now() }]);
        setDraft("");
      }
      setError(null);
      setPending(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, history }),
          signal: controller.signal,
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          setError({ text: errorFor(res.status, body), retry: res.status === 401 || res.status === 404 ? null : message });
          return;
        }
        const data = body as ChatResponse;
        setMessages((ms) => [
          ...ms,
          {
            id: data.id || newId(),
            role: "assistant",
            content: data.answer,
            at: Date.now(),
            queries: data.queries ?? [],
            data: data.data ?? null,
            coverageChecked: data.coverageChecked === true,
            warnings: data.warnings ?? [],
            usage: data.usage,
            stopReason: data.stopReason,
          },
        ]);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setError({ text: "Couldn't reach the server. Check your connection and try again.", retry: message });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setPending(false);
        inputRef.current?.focus();
      }
    },
    [messages, pending],
  );

  const clear = () => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setPending(false);
    inputRef.current?.focus();
  };

  const empty = loaded && messages.length === 0 && !pending;

  return (
    <Panel className="flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="size-4 text-primary" aria-hidden />
          <h2 className="eyebrow text-muted-foreground">Conversation</h2>
          <span className="truncate text-[12px] text-muted-foreground">· stored in this browser only</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={clear}
          disabled={messages.length === 0 && !error}
          aria-label="Clear conversation history"
        >
          <Eraser aria-hidden />
          Clear
        </Button>
      </div>

      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation with the lot assistant"
        className="h-[calc(100dvh-330px)] min-h-[360px] space-y-4 overflow-y-auto px-5 py-5 text-[13px]"
      >
        {empty && <EmptyState onPick={(q) => void send(q)} model={model} />}

        {messages.map((m) =>
          m.role === "user" ? <UserBubble key={m.id} text={m.content} /> : <AssistantCard key={m.id} msg={m} />,
        )}

        {pending && (
          <div className="flex max-w-[85%] items-center gap-2 rounded-[10px] border bg-muted/30 px-4 py-3 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden />
            <span>Thinking… running SQL</span>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="flex max-w-[85%] flex-wrap items-center gap-3 rounded-[10px] border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive"
          >
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{error.text}</span>
            {error.retry && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => void send(error.retry!, { retry: true })}
                disabled={pending}
                aria-label="Retry the last question"
              >
                <RotateCcw aria-hidden />
                Retry
              </Button>
            )}
          </div>
        )}
      </div>

      <form
        className="border-t bg-muted/20 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <label htmlFor="ask-input" className="sr-only">
          Ask a question about the parking lot
        </label>
        <div className="flex items-end gap-2">
          <Textarea
            id="ask-input"
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(draft);
              }
            }}
            maxLength={MAX_MESSAGE_CHARS}
            rows={1}
            placeholder="Ask about entries, dwell, occupancy, overnight cars…"
            disabled={pending}
            className="max-h-40 min-h-10 resize-none text-[13px] md:text-[13px]"
          />
          <Button
            type="submit"
            size="icon-lg"
            disabled={pending || draft.trim().length === 0}
            aria-label={pending ? "Waiting for answer" : "Send question"}
          >
            {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : <SendHorizontal aria-hidden />}
          </Button>
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
          <span>
            <kbd className="font-mono">Enter</kbd> to send · <kbd className="font-mono">Shift+Enter</kbd> for a new line
          </span>
          <span className="num">
            {draft.length}/{MAX_MESSAGE_CHARS}
          </span>
        </div>
      </form>
    </Panel>
  );
}

function EmptyState({ onPick, model }: { onPick: (q: string) => void; model: string }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-8 text-center">
      <span className="icon-tile mb-3" aria-hidden>
        <Database className="size-5" />
      </span>
      <p className="text-[15px] font-semibold">Ask anything about the lot</p>
      <p className="mt-1 text-muted-foreground">
        <span className="num">{model}</span> writes read-only SQL against the lot views, checks data coverage first,
        and shows you every query it ran.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((q) => (
          <Button
            key={q}
            variant="outline"
            size="sm"
            className="rounded-full text-[12.5px]"
            onClick={() => onPick(q)}
          >
            {q}
          </Button>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-[10px] rounded-br-sm border border-primary/25 bg-primary/12 px-4 py-2.5 whitespace-pre-wrap text-foreground">
        <span className="sr-only">You asked: </span>
        {text}
      </div>
    </div>
  );
}

function AssistantCard({ msg }: { msg: AssistantMessage }) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%] rounded-[10px] border bg-card px-4 py-3">
        <span className="sr-only">Assistant answered: </span>
        <p className="leading-relaxed whitespace-pre-wrap">{msg.content}</p>

        {msg.warnings.length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {msg.warnings.map((w) => (
              <li
                key={w}
                className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[12px] text-warning"
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}

        {msg.data && msg.data.rows.length > 0 && <DataPreview table={msg.data} />}

        {msg.queries.length > 0 && <Provenance msg={msg} />}
      </div>
    </div>
  );
}

function DataPreview({ table }: { table: Table }) {
  const rows = table.rows.slice(0, TABLE_PREVIEW_ROWS);
  return (
    <div className="mt-3">
      <div className="eyebrow mb-1.5 text-muted-foreground">
        Result{" "}
        <span className="num normal-case tracking-normal">
          ({rows.length < table.rows.length ? `first ${rows.length} of ${table.rows.length}` : `${rows.length}`} rows)
        </span>
      </div>
      <div className="max-h-72 overflow-auto rounded-md border">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {table.columns.map((c) => (
                <th key={c} scope="col" className="px-2.5 py-1.5 text-left font-medium whitespace-nowrap text-muted-foreground">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t">
                {r.map((v, j) => (
                  <td
                    key={j}
                    className={cn(
                      "num px-2.5 py-1 whitespace-nowrap",
                      typeof v === "number" ? "text-right" : "text-left",
                      (v === null || v === undefined) && "text-muted-foreground",
                    )}
                  >
                    {formatCell(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Provenance({ msg }: { msg: AssistantMessage }) {
  const [open, setOpen] = useState(false);
  const n = msg.queries.length;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3 border-t pt-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
            <span className="eyebrow">Provenance</span>
            <span className="num">
              · {n} {n === 1 ? "query" : "queries"}
            </span>
          </button>
        </CollapsibleTrigger>
        {msg.coverageChecked ? (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-success">
            <CircleCheck className="size-3.5" aria-hidden />
            Coverage checked
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-warning">
            <TriangleAlert className="size-3.5" aria-hidden />
            Coverage not checked
          </span>
        )}
      </div>
      <CollapsibleContent>
        <ol className="mt-2 space-y-3">
          {msg.queries.map((q, i) => (
            <li key={i}>
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="eyebrow text-muted-foreground">Query {i + 1}</span>
                <Badge variant="outline" className="num">
                  {q.rowCount === null ? "—" : q.rowCount} rows
                </Badge>
                <Badge variant="outline" className="num">
                  {q.durationMs} ms
                </Badge>
                {q.truncated && (
                  <Badge variant="outline" className="border-warning/40 text-warning">
                    truncated
                  </Badge>
                )}
                {q.isError && <Badge variant="destructive">error</Badge>}
              </div>
              <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
                {q.sql ?? `(${q.tool}: no SQL)`}
              </pre>
            </li>
          ))}
        </ol>
        {msg.usage && (msg.usage.inputTokens > 0 || msg.usage.outputTokens > 0) && (
          <p className="num mt-2 text-[11px] text-muted-foreground">
            {msg.usage.inputTokens.toLocaleString()} in / {msg.usage.outputTokens.toLocaleString()} out tokens
            {msg.stopReason ? ` · ${msg.stopReason}` : ""}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
