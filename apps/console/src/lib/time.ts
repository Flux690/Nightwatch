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

// How long something took, in the same bare units. Null when either end is
// unreadable, so a caller drops the clause rather than printing "NaNm".
export function elapsed(from: string, to: string): string | null {
  const span = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(span) || span < 0) return null;
  const mins = Math.round(span / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return mins % 60 === 0 ? `${hours}h` : `${hours}h ${mins % 60}m`;
}

export const DAY_GROUPS = ["Today", "Yesterday", "Older"] as const;

type DayGroup = (typeof DAY_GROUPS)[number];

// Calendar days apart, not hours: 23:50 yesterday and 00:10 today are twenty
// minutes and two days, and the user remembers which day they spoke.
export function dayGroup(dateString: string): DayGroup {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const at = new Date(dateString).getTime();
  if (at >= midnight.getTime()) return "Today";
  if (at >= midnight.getTime() - 86_400_000) return "Yesterday";
  return "Older";
}
