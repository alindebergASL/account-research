export function isSafeSourceUrl(source: string): boolean {
  try {
    const parsed = new URL(source);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function SourceLink({
  source,
  className = "text-accent hover:underline break-all",
  mutedClassName = "text-muted",
}: {
  source: string;
  className?: string;
  mutedClassName?: string;
}) {
  if (!source) return <span className="text-muted">—</span>;
  if (isSafeSourceUrl(source)) {
    return (
      <a
        href={source}
        target="_blank"
        rel="noreferrer noopener"
        className={className}
      >
        {source}
      </a>
    );
  }
  return <span className={mutedClassName}>{source}</span>;
}
