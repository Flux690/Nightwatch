// Decoding the untrusted side of the socket. A command's input arrives as JSON, so a
// registry that asserted its shape would be trusting the sender; these read and check.

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("command input must be an object");
  }
  // The one narrowing in the decoder, justified by the three checks above.
  return input as Record<string, unknown>;
}

export function requiredString(input: unknown, key: string): string {
  const value = record(input)[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`command input needs a non-empty "${key}"`);
  }
  return value;
}

export function optionalString(
  input: unknown,
  key: string,
): string | undefined {
  const value = record(input)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`"${key}" must be a string`);
  }
  return value;
}

export function optionalNumber(
  input: unknown,
  key: string,
): number | undefined {
  const value = record(input)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${key}" must be a number`);
  }
  return value;
}

export function optionalBoolean(
  input: unknown,
  key: string,
): boolean | undefined {
  const value = record(input)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`"${key}" must be a boolean`);
  }
  return value;
}

export function requiredStringArray(input: unknown, key: string): string[] {
  const value = record(input)[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`"${key}" must be an array of strings`);
  }
  return value;
}

export function optionalStringArray(
  input: unknown,
  key: string,
): string[] | undefined {
  const value = record(input)[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`"${key}" must be an array of strings`);
  }
  return value;
}

// The nested object every service-routed command carries, read through the same
// checks so a malformed identity fails here rather than deep in a platform client.
export function nested(input: unknown, key: string): unknown {
  const value = record(input)[key];
  if (typeof value !== "object" || value === null) {
    throw new Error(`command input needs a "${key}" object`);
  }
  return value;
}
