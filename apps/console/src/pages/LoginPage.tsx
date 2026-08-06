import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";

import { ICON_INLINE } from "@/lib/iconProps";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/auth/AuthContext";

const MIN_PASSWORD = 12;

/* The error is revealed rather than reserved for: FieldError renders nothing
   when there is no message, so no empty live region sits in the accessibility
   tree, and the input is marked as well as the space. */
function AuthField({
  id,
  label,
  type,
  value,
  error,
  onChange,
  onBlur,
}: {
  id: string;
  label: string;
  type: "email" | "password";
  value: string;
  error?: string;
  onChange: (value: string) => void;
  onBlur?: (value: string) => void;
}): React.JSX.Element {
  const invalid = Boolean(error);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        required
        value={value}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.currentTarget.value)}
        onBlur={(e) => onBlur?.(e.currentTarget.value)}
      />
      {invalid && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}

/* A legend is pulled out of the fieldset's own flow, so a flex gap never
   applies to it and the first field sits closer than every other. The form is
   one group with one heading, which is a heading rather than a legend. */
function FormHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h1 className="m-0 text-2xl font-semibold tracking-[-0.3px] text-foreground">
      {children}
    </h1>
  );
}

function ServerError({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="flex items-start gap-1 text-sm text-destructive" role="alert">
      <AlertCircle {...ICON_INLINE} className="mt-px shrink-0" />
      <span>{message}</span>
    </p>
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
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => void handleSubmit(e)}
    >
      <FormHeading>Create your account</FormHeading>
      <AuthField
        id="setup-email"
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
      />
      <AuthField
        id="setup-password"
        label="Password"
        type="password"
        value={password}
        error={passwordError}
        onChange={setPassword}
        onBlur={validatePassword}
      />
      <AuthField
        id="setup-confirm"
        label="Confirm password"
        type="password"
        value={confirmPassword}
        error={confirmError}
        onChange={setConfirmPassword}
        onBlur={(v) => validateConfirm(v, password)}
      />
      <div className="flex flex-col gap-2">
        {serverError && <ServerError message={serverError} />}
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting && <Spinner className="size-4" />}
          Create account
        </Button>
      </div>
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
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => void handleSubmit(e)}
    >
      <FormHeading>Log in</FormHeading>
      <AuthField
        id="login-email"
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
      />
      <AuthField
        id="login-password"
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
      />
      <div className="flex flex-col gap-2">
        {serverError && <ServerError message={serverError} />}
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting && <Spinner className="size-4" />}
          Log in
        </Button>
      </div>
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
      <div className="flex w-90 flex-col gap-8">
        <span className="text-lg font-semibold tracking-tight text-foreground">
          NightWarden
        </span>
        {phase.kind === "needs-setup" ? <SetupForm /> : <LoginForm />}
      </div>
    </div>
  );
}
