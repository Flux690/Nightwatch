// Relative timestamp formatting for the console. Null renders as "never" so
// callers can pass a nullable lastSeen directly.
export function timeAgo(dateString: string | null): string {
  if (dateString === null) return "never";
  const diff = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
