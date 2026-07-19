import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { ICON_INLINE } from "@/lib/iconProps";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/auth/AuthContext";

const MIN_PASSWORD = 12;

function ValidationError({ message }: { message: string }): React.JSX.Element {
  return (
    <div
      className="flex min-h-[18px] items-start gap-1 text-sm text-destructive"
      role="alert"
    >
      {message && (
        <>
          <AlertCircle {...ICON_INLINE} className="mt-px shrink-0" />
          <span>{message}</span>
        </>
      )}
    </div>
  );
}

function SetupForm(): React.JSX.Element {
  const { signup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function validatePassword(value: string): boolean {
    if (value === "") {
      setPasswordError("");
      return true;
    }
    const tooShort = value.length < MIN_PASSWORD;
    setPasswordError(
      tooShort ? `Password must be at least ${MIN_PASSWORD} characters` : "",
    );
    return !tooShort;
  }

  function validateConfirm(value: string, against: string): boolean {
    if (value === "") {
      setConfirmError("");
      return true;
    }
    const mismatched = value !== against;
    setConfirmError(mismatched ? "Passwords do not match" : "");
    return !mismatched;
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setServerError("");

    const passwordOk = validatePassword(password);
    const confirmOk = validateConfirm(confirmPassword, password);
    if (!passwordOk || !confirmOk) return;

    setSubmitting(true);
    try {
      const result = await signup(email, password);
      if (!result.ok) setServerError(result.error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="w-90" onSubmit={(e) => void handleSubmit(e)}>
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-6 p-0 text-2xl font-semibold tracking-[-0.3px] text-foreground">
          Create your account
        </legend>
        {serverError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="setup-email">Email</FieldLabel>
            <Input
              id="setup-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <Field>
              <FieldLabel htmlFor="setup-password">Password</FieldLabel>
              <Input
                id="setup-password"
                type="password"
                required
                value={password}
                aria-invalid={Boolean(passwordError)}
                onChange={(e) => setPassword(e.currentTarget.value)}
                onBlur={(e) => validatePassword(e.currentTarget.value)}
              />
            </Field>
            <ValidationError message={passwordError} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Field>
              <FieldLabel htmlFor="setup-confirm">Confirm password</FieldLabel>
              <Input
                id="setup-confirm"
                type="password"
                required
                value={confirmPassword}
                aria-invalid={Boolean(confirmError)}
                onChange={(e) => setConfirmPassword(e.currentTarget.value)}
                onBlur={(e) => validateConfirm(e.currentTarget.value, password)}
              />
            </Field>
            <ValidationError message={confirmError} />
          </div>
        </div>
        <div className="mt-6 flex justify-start">
          <Button type="submit" className="px-6" disabled={submitting}>
            {submitting && <Spinner className="size-4" />}
            Create account
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function LoginForm(): React.JSX.Element {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await login(email, password);
      setServerError(result.ok ? "" : result.error);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="w-90" onSubmit={(e) => void handleSubmit(e)}>
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-6 p-0 text-2xl font-semibold tracking-[-0.3px] text-foreground">
          Log in
        </legend>
        {serverError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="login-email">Email</FieldLabel>
            <Input
              id="login-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="login-password">Password</FieldLabel>
            <Input
              id="login-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
          </Field>
        </div>
        <div className="mt-6 flex justify-start">
          <Button type="submit" className="px-6" disabled={submitting}>
            {submitting && <Spinner className="size-4" />}
            Log in
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function LoginPage(): React.JSX.Element | null {
  const { phase } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (phase.kind === "authenticated") void navigate({ to: "/" });
  }, [phase.kind, navigate]);

  if (phase.kind === "loading" || phase.kind === "authenticated") return null;

  return (
    <div className="flex min-h-screen items-start justify-center p-6 pt-[clamp(96px,18vh,240px)]">
      {phase.kind === "needs-setup" ? <SetupForm /> : <LoginForm />}
    </div>
  );
}
