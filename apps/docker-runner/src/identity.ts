// The name this runner is addressed by, pushed by the API on connect and held in
// memory only: it is identity, not durable state, and every reconnect resupplies it.
let assigned: string | null = null;

export function setServerName(name: string): void {
  assigned = name;
}

// Throws rather than substituting a placeholder, because a key built without the
// real name would route somewhere, just not where the model asked.
export function serverName(): string {
  if (assigned === null) {
    throw new Error("server name has not arrived from the API yet");
  }
  return assigned;
}
