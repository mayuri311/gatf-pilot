"use client";

import { useEffect, useRef, useState } from "react";

// Conversation history lives client-side and is POSTed back each turn. The
// Messages API is stateless, so a server-side store would buy nothing here.
// Only plain text turns are kept — tool_use / tool_result blocks are dropped,
// which keeps payloads small and avoids the unpaired-block 400s you get from
// trying to replay a partial tool exchange. The server re-caps and re-validates
// everything on arrival regardless; this is convenience, not a trust boundary.

const HISTORY_KEY = "gatf-chat-history";

type QueryRecord = {
  tool: string;
  sql: string | null;
  rowCount: number | null;
  durationMs: number;
  truncated: boolean;
  isError: boolean;
};

type ChatResponse = {
  id: string;
  answer: string;
  queries: QueryRecord[];
  data: { columns: string[]; rows: unknown[][] } | null;
  coverageChecked: boolean;
  usage: { inputTokens: number; outputTokens: number };
  warnings: string[];
};

type Turn =
  | { role: "user"; content: string }
  | ({ role: "assistant"; content: string } & Partial<Omit<ChatResponse, "answer">>);

const SUGGESTIONS = [
  "How many cars entered this morning?",
  "What were peak hours today?",
  "When was the lot least occupied today?",
  "How full was the lot yesterday at 2pm?",
];

export default function ChatPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Restore on mount so a refresh doesn't lose the conversation.
  useEffect(() => {
    const saved = sessionStorage.getItem(HISTORY_KEY);
    if (saved) {
      try {
        setTurns(JSON.parse(saved) as Turn[]);
      } catch {
        sessionStorage.removeItem(HISTORY_KEY);
      }
    }
  }, []);

  useEffect(() => {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(turns));
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  async function send(question: string) {
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    setError(null);
    setPending(true);
    setInput("");

    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((prev) => [...prev, { role: "user", content: trimmed }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history }),
      });

      if (res.status === 401) {
        window.location.href = "/login?next=/chat";
        return;
      }

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Request failed (${res.status}).`);
        return;
      }

      const data = body as ChatResponse;
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer,
          queries: data.queries,
          data: data.data,
          coverageChecked: data.coverageChecked,
          usage: data.usage,
          warnings: data.warnings,
        },
      ]);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  function reset() {
    setTurns([]);
    sessionStorage.removeItem(HISTORY_KEY);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col bg-neutral-950 p-6 text-neutral-100">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Ask the lot</h1>
          <p className="text-sm text-neutral-400">
            Read-only questions about entries, exits, and occupancy.
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <a href="/" className="text-neutral-400 hover:text-neutral-200">
            Dashboard
          </a>
          {turns.length > 0 && (
            <button onClick={reset} className="text-neutral-400 hover:text-neutral-200">
              Clear
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 space-y-4">
        {turns.length === 0 && (
          <div className="space-y-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="block w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-2.5 text-left text-sm text-neutral-300 hover:border-neutral-700"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-lg bg-neutral-800 px-4 py-2.5 text-sm">
                {turn.content}
              </div>
            </div>
          ) : (
            <AssistantTurn key={i} turn={turn} />
          ),
        )}

        {pending && (
          <p className="text-sm text-neutral-500">Querying…</p>
        )}
        {error && (
          <p className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-2.5 text-sm text-red-300">
            {error}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="sticky bottom-0 mt-6 flex gap-2 bg-neutral-950 pt-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about entries, exits, or occupancy…"
          maxLength={2000}
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        <button
          type="submit"
          disabled={pending || input.trim().length === 0}
          className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </main>
  );
}

function AssistantTurn({ turn }: { turn: Extract<Turn, { role: "assistant" }> }) {
  const [showSql, setShowSql] = useState(false);
  const queries = turn.queries ?? [];

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
      <p className="whitespace-pre-wrap text-sm">{turn.content}</p>

      {turn.warnings && turn.warnings.length > 0 && (
        <ul className="mt-3 space-y-1">
          {turn.warnings.map((w) => (
            <li key={w} className="text-xs text-amber-400">
              ⚠ {w}
            </li>
          ))}
        </ul>
      )}

      {turn.data && turn.data.rows.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-md border border-neutral-800">
          <table className="w-full text-xs">
            <thead className="bg-neutral-950 text-neutral-400">
              <tr>
                {turn.data.columns.map((c) => (
                  <th key={c} className="px-3 py-2 text-left font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {turn.data.rows.slice(0, 20).map((row, i) => (
                <tr key={i} className="border-t border-neutral-800">
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-1.5">
                      {cell === null ? "—" : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Provenance: these fields are recorded server-side from the tool calls
          that actually ran, so every figure above can be traced to its query. */}
      {queries.length > 0 && (
        <div className="mt-3 border-t border-neutral-800 pt-2">
          <div className="flex items-center gap-3 text-xs text-neutral-500">
            <button
              onClick={() => setShowSql((v) => !v)}
              className="hover:text-neutral-300"
            >
              {showSql ? "Hide" : "Show"} SQL ({queries.length})
            </button>
            <span title="Whether lot_data_coverage was queried before answering">
              {turn.coverageChecked ? "✓ coverage verified" : "⚠ coverage unverified"}
            </span>
            {turn.usage && (
              <span className="ml-auto">
                {turn.usage.inputTokens + turn.usage.outputTokens} tokens
              </span>
            )}
          </div>

          {showSql && (
            <div className="mt-2 space-y-2">
              {queries.map((q, i) => (
                <div key={i} className="rounded-md bg-neutral-950 p-2">
                  <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-neutral-300">
                    {q.sql ?? `(${q.tool})`}
                  </pre>
                  <p className="mt-1 text-xs text-neutral-500">
                    {q.isError ? "error" : `${q.rowCount ?? "?"} rows`} · {q.durationMs}ms
                    {q.truncated && " · truncated"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
