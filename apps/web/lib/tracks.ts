export interface TrackMeta {
  label: string;
  /** CSS color reference, defined per mode in globals.css */
  color: string;
}

const TRACKS: Record<string, TrackMeta> = {
  bcg: { label: "BCG", color: "var(--track-bcg)" },
  salesforce: { label: "Salesforce", color: "var(--track-salesforce)" },
  anthropic: { label: "Anthropic", color: "var(--track-anthropic)" },
  lessons: { label: "Lessons", color: "var(--track-lessons)" },
  portfolio: { label: "Portfolio", color: "var(--track-portfolio)" },
  apply: { label: "Apply", color: "var(--track-apply)" },
};

export function track(id: string | undefined): TrackMeta {
  if (id && TRACKS[id]) return TRACKS[id]!;
  return { label: id ?? "Task", color: "var(--muted-foreground)" };
}
