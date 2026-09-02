// Bare units, so an age can sit in a right-aligned cluster and a caller
// wanting a sentence supplies the "ago". Null renders as "never".
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

// Every absolute time comes through here, so a report's timeline and the chart
// beside it cannot disagree. 24-hour, because logs and metrics are.
export function clock(at: string | number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return typeof at === "string" ? at : "";
  const h = String(d.getHours()).padStart(2, "0");
  return `${h}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// The same clock with its day in front, for a time that may not be today.
export function dayClock(at: string | number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return typeof at === "string" ? at : "";
  const day = d.toLocaleDateString([], { day: "numeric", month: "short" });
  return `${day} ${clock(at)}`;
}

/* A Date is an instant, so both of the above already read in the viewer's own
   zone. Naming it stops a quoted time meaning two things to two people. */
export function zoneName(): string {
  const parts = new Intl.DateTimeFormat([], {
    timeZoneName: "short",
  }).formatToParts(new Date());
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
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
