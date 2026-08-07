// The console's one relative timestamp. Bare units, so an age can sit in a
// right-aligned cluster; a caller that wants a sentence supplies the "ago".
// Null renders as "never", so a nullable lastSeen passes straight in.
export function timeAgo(dateString: string | null): string {
  if (dateString === null) return "never";
  const diff = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
