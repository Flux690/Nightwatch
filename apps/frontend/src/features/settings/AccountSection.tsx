import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Field, FieldError, FieldLabel } from "@/shared/ui/field";
import { StatusText } from "@/shared/ui/status";
import { Spinner } from "@/shared/ui/spinner";
import { useAuth } from "@/features/auth/AuthContext";
import { timeAgo } from "@/shared/lib/time";
import { SettingsGroup, SettingsRow } from "./SettingsRow";

interface DeviceSession {
  token: string;
  userAgent: string | null;
  createdAt: string;
}

// Better Auth returns the whole row; only these three are drawn, and the IP
// deliberately is not.
function readSessions(body: unknown): DeviceSession[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => {
    const { token, userAgent, createdAt } = row as Partial<DeviceSession>;
    if (typeof token !== "string" || typeof createdAt !== "string") return [];
    return [{ token, userAgent: userAgent ?? null, createdAt }];
  });
}

/* A user agent is a long string nobody reads, so it is reduced to the two facts
   that identify a device: which browser, on which system. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const system = /Mac OS X/.test(userAgent)
    ? "macOS"
    : /Windows/.test(userAgent)
      ? "Windows"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad/.test(userAgent)
          ? "iOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "an unknown system";
  return `${browser} on ${system}`;
}

function PasswordField({
  id,
  label,
  value,
  autoComplete,
  inputRef,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  autoComplete: "current-password" | "new-password";
  inputRef?: React.Ref<HTMLInputElement>;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        ref={inputRef}
        type="password"
        required
        measure="beside"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </Field>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  // The form arrives on a click, so the caret goes with it rather than leaving
  // a keyboard user to hunt for what just appeared.
  useEffect(() => first.current?.focus(), []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError("");
    if (next !== confirm) {
      setError("The two new passwords do not match");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Every other device is signed out, because a password is changed when
      // one of them is no longer trusted.
      body: JSON.stringify({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? "Could not change the password");
      return;
    }
    onDone();
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
      <PasswordField
        id="settings-current-password"
        label="Current password"
        value={current}
        autoComplete="current-password"
        inputRef={first}
        onChange={setCurrent}
      />
      <PasswordField
        id="settings-new-password"
        label="New password"
        value={next}
        autoComplete="new-password"
        onChange={setNext}
      />
      <PasswordField
        id="settings-confirm-password"
        label="Confirm new password"
        value={confirm}
        autoComplete="new-password"
        onChange={setConfirm}
      />
      {error !== "" && <FieldError>{error}</FieldError>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          Change password
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Devices(): React.JSX.Element {
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/auth/list-sessions");
    setSessions(res.ok ? readSessions(await res.json()) : []);
  }, []);

  useEffect(() => void load(), [load]);

  async function revoke(token: string): Promise<void> {
    await fetch("/api/auth/revoke-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    await load();
  }

  if (sessions === null) return <Spinner />;
  if (sessions.length === 0) {
    return <StatusText tone="muted">No signed-in devices</StatusText>;
  }

  return (
    <ul
      aria-labelledby="settings-devices-label"
      className="flex list-none flex-col gap-2 p-0"
    >
      {sessions.map((session) => (
        <li
          key={session.token}
          className="flex items-center justify-between gap-6"
        >
          <span className="text-sm text-foreground">
            {describeDevice(session.userAgent)}
            <span className="text-muted-foreground">
              {" "}
              signed in {timeAgo(session.createdAt)}
            </span>
          </span>
          <Button
            type="button"
            variant="destructive-ghost"
            onClick={() => void revoke(session.token)}
          >
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}

interface AccountSectionProps {
  onLogoutAll: () => void;
}

export function AccountSection({
  onLogoutAll,
}: AccountSectionProps): React.JSX.Element {
  const { phase } = useAuth();
  const [changing, setChanging] = useState(false);
  const identity =
    phase.kind === "authenticated"
      ? `${phase.name} (${phase.email})`
      : "Not signed in";

  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup title="You">
        <SettingsRow
          controlId="settings-identity"
          title="Signed in as"
          description="The name recorded against every write you approve."
          titleOnly
        >
          <span
            aria-labelledby="settings-identity-label"
            className="text-sm text-foreground"
          >
            {identity}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Security">
        {/* The form arrives on demand: it is three fields for something done
            twice a year, beside rows that are one line each. */}
        <SettingsRow
          controlId="settings-password"
          title="Password"
          description="Changing it signs out every other device."
          stacked={changing}
          titleOnly
        >
          {changing ? (
            <ChangePassword onDone={() => setChanging(false)} />
          ) : (
            /* Announced as "Password Change". No aria-expanded: the form
               replaces this button rather than revealing a region it controls. */
            <Button
              type="button"
              variant="secondary"
              id="settings-password-change"
              aria-labelledby="settings-password-label settings-password-change"
              onClick={() => setChanging(true)}
            >
              Change
            </Button>
          )}
        </SettingsRow>
        <SettingsRow
          controlId="settings-devices"
          title="Signed-in devices"
          description="Revoke one you do not recognise."
          stacked
          titleOnly
        >
          <Devices />
        </SettingsRow>
        <SettingsRow
          controlId="settings-logout-all"
          title="Log out all devices"
          description="Ends every signed-in session, including this one."
        >
          <Button
            id="settings-logout-all"
            type="button"
            variant="destructive-ghost"
            onClick={onLogoutAll}
          >
            Log out everywhere
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
