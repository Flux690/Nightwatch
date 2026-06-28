import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Center,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";

import { useAuth } from "../auth/AuthContext.js";

const MIN_PASSWORD = 12;

function SetupForm(): React.JSX.Element {
  const { signup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [serverError, setServerError] = useState("");

  function validatePassword(value: string): boolean {
    // An untouched empty field is not yet a violation of this rule - the
    // required attribute handles blocking an empty submission.
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

    const result = await signup(email, password);
    if (!result.ok) setServerError(result.error);
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <Stack gap="sm" style={{ width: "min(480px, 100%)" }}>
        <Title order={2} size="h4">
          Create your account
        </Title>
        <Alert
          color="red"
          style={{ visibility: serverError ? "visible" : "hidden" }}
        >
          {serverError || " "}
        </Alert>
        <TextInput
          label="Email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
        <div>
          <PasswordInput
            label="Password"
            required
            value={password}
            error={Boolean(passwordError)}
            onChange={(e) => setPassword(e.currentTarget.value)}
            onBlur={(e) => validatePassword(e.currentTarget.value)}
          />
          <Text
            size="xs"
            c="red"
            mih={18}
            style={{ visibility: passwordError ? "visible" : "hidden" }}
          >
            {passwordError || " "}
          </Text>
        </div>
        <div>
          <PasswordInput
            label="Confirm password"
            required
            value={confirmPassword}
            error={Boolean(confirmError)}
            onChange={(e) => setConfirmPassword(e.currentTarget.value)}
            onBlur={(e) => validateConfirm(e.currentTarget.value, password)}
          />
          <Text
            size="xs"
            c="red"
            mih={18}
            style={{ visibility: confirmError ? "visible" : "hidden" }}
          >
            {confirmError || " "}
          </Text>
        </div>
        <Button type="submit">Create account</Button>
      </Stack>
    </form>
  );
}

function LoginForm(): React.JSX.Element {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [serverError, setServerError] = useState("");

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const result = await login(email, password);
    setServerError(result.ok ? "" : result.error);
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <Stack gap="sm" style={{ width: "min(480px, 100%)" }}>
        <Title order={2} size="h4">
          Log in
        </Title>
        <Alert
          color="red"
          style={{ visibility: serverError ? "visible" : "hidden" }}
        >
          {serverError || " "}
        </Alert>
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
        <Button type="submit">Log in</Button>
      </Stack>
    </form>
  );
}

export function LoginPage(): React.JSX.Element | null {
  const { phase } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // Reachable directly (bookmark, manual URL, refresh) even once already
    // authenticated - send the operator home instead of re-showing a form.
    if (phase.kind === "authenticated") void navigate({ to: "/" });
  }, [phase.kind, navigate]);

  if (phase.kind === "loading" || phase.kind === "authenticated") return null;

  return (
    <Center mih="100vh" p="md">
      {phase.kind === "needs-setup" ? <SetupForm /> : <LoginForm />}
    </Center>
  );
}
