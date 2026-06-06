import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalRequest } from "@nightwatch/shared";

const POLL_MS = 3000;

async function fetchPending(): Promise<ApprovalRequest[]> {
  const res = await fetch("/api/incidents/pending");
  if (!res.ok) throw new Error(`pending fetch failed: ${res.status}`);
  const body = (await res.json()) as { pending: ApprovalRequest[] };
  return body.pending;
}

function ApprovalsPage(): React.JSX.Element {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setPending(await fetchPending());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const resolve = useCallback(
    async (incidentId: string, action: "approve" | "reject") => {
      setBusy(incidentId);
      try {
        const res = await fetch(`/api/incidents/${incidentId}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resolvedBy: "console" }),
        });
        if (!res.ok) throw new Error(`${action} failed: ${res.status}`);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return (
    <div
      style={{ fontFamily: "system-ui", maxWidth: 720, margin: "2rem auto" }}
    >
      <h1>Nightwatch - Pending Approvals</h1>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {pending.length === 0 && <p>No approvals pending.</p>}
      {pending.map((a) => (
        <div
          key={a.id}
          style={{
            border: "1px solid #ccc",
            borderRadius: 8,
            padding: "1rem",
            marginBottom: "1rem",
          }}
        >
          <div>
            <strong>{a.toolName}</strong> on incident{" "}
            <code>{a.incidentId}</code>
          </div>
          <pre style={{ background: "#f5f5f5", padding: "0.5rem" }}>
            {JSON.stringify(a.toolInput, null, 2)}
          </pre>
          <button
            disabled={busy === a.incidentId}
            onClick={() => void resolve(a.incidentId, "approve")}
          >
            Approve
          </button>{" "}
          <button
            disabled={busy === a.incidentId}
            onClick={() => void resolve(a.incidentId, "reject")}
          >
            Reject
          </button>
        </div>
      ))}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <ApprovalsPage />
  </StrictMode>,
);
