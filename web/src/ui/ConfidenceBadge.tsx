export function ConfidenceBadge({ value, label = "Confidence" }: { value: unknown; label?: string }) {
  if (!value || typeof value !== "object") return null;
  const v = value as { percent?: unknown; level?: unknown; basis?: unknown; note?: unknown };
  if (typeof v.percent !== "number" || !Number.isFinite(v.percent) || v.percent < 0 || v.percent > 100) return null;
  const level = typeof v.level === "string" ? v.level : "";
  const explanation = [label, `${v.percent}% · ${level}`, v.basis, v.note].filter(Boolean).join(". ");
  return <span title={explanation} tabIndex={0} aria-label={explanation} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8, color: "var(--action)", fontSize: 11, lineHeight: 1.2, flexShrink: 0 }}>
    <svg width="38" height="38" viewBox="0 0 40 40" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="20" cy="20" r="17" fill="none" stroke="var(--line)" strokeWidth="3" />
      <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeWidth="3" pathLength="100" strokeDasharray={`${v.percent} 100`} transform="rotate(-90 20 20)" />
      <text x="20" y="21" textAnchor="middle" dominantBaseline="middle" fill="currentColor" fontSize="10" fontWeight="600">{v.percent}%</text>
    </svg>
    <span>{label}<br /><strong>{level}</strong></span>
  </span>;
}
