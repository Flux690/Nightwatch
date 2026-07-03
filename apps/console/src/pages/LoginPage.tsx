import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";

import { Alert } from "../ui/Alert.js";
import { Button } from "../ui/Button.js";
import { PasswordInput } from "../ui/PasswordInput.js";
import { TextInput } from "../ui/TextInput.js";
import { useAuth } from "../auth/AuthContext.js";

const MIN_PASSWORD = 12;

function ValidationError({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="validation-error" role="alert">
      {message && (
        <>
          <AlertCircle
            size={14}
            className="validation-error__icon"
            aria-hidden="true"
          />
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
    <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
      <fieldset className="auth-fieldset">
        <legend className="auth-title">Create your account</legend>
        {serverError && (
          <Alert intent="error" className="auth-alert">
            {serverError}
          </Alert>
        )}
        <div className="auth-fields">
          <TextInput
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
          <div className="auth-field-group">
            <PasswordInput
              label="Password"
              required
              value={password}
              error={Boolean(passwordError)}
              onChange={(e) => setPassword(e.currentTarget.value)}
              onBlur={(e) => validatePassword(e.currentTarget.value)}
            />
            <ValidationError message={passwordError} />
          </div>
          <div className="auth-field-group">
            <PasswordInput
              label="Confirm password"
              required
              value={confirmPassword}
              error={Boolean(confirmError)}
              onChange={(e) => setConfirmPassword(e.currentTarget.value)}
              onBlur={(e) => validateConfirm(e.currentTarget.value, password)}
            />
            <ValidationError message={confirmError} />
          </div>
        </div>
        <div className="auth-actions">
          <Button type="submit" className="auth-submit" loading={submitting}>
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
    <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
      <fieldset className="auth-fieldset">
        <legend className="auth-title">Log in</legend>
        {serverError && (
          <Alert intent="error" className="auth-alert">
            {serverError}
          </Alert>
        )}
        <div className="auth-fields">
          <TextInput
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
          <PasswordInput
            label="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
        <div className="auth-actions">
          <Button type="submit" className="auth-submit" loading={submitting}>
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
    <div className="auth-screen">
      {phase.kind === "needs-setup" ? <SetupForm /> : <LoginForm />}
    </div>
  );
}
