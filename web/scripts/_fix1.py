p = "app/brief/[id]/JournalSection.tsx"
s = open(p).read()

# --- 1) Root fix: every staged prompt navigates to where the composer lives ---
old = ("    setComposeText(text);\n"
       "    window.setTimeout(() => composeRef.current?.focus(), 0);\n  }")
new = ("    setComposeText(text);\n"
       "    // The composer only renders in Timeline/Team Room, so staging a prompt\n"
       "    // anywhere else must bring the user to it — otherwise the action looks\n"
       "    // like it silently did nothing.\n"
       '    setActiveWorkspace("timeline");\n'
       "    window.setTimeout(() => composeRef.current?.focus(), 0);\n  }")
assert s.count(old) == 1, "prepareAssistantPrompt nav"
s = s.replace(old, new)

# --- 2) Clipboard fallback also stages into the composer; take the user there ---
old = ('      setComposeText(prompt);\n'
       '      setAskAi(false);\n'
       '      setUploadNotice("Clipboard was unavailable, so the brief-chat prompt was copied into the Journal composer.");')
new = ('      setComposeText(prompt);\n'
       '      setAskAi(false);\n'
       '      setActiveWorkspace("timeline");\n'
       '      window.setTimeout(() => composeRef.current?.focus(), 0);\n'
       '      setUploadNotice("Clipboard was unavailable, so the brief-chat prompt was copied into the Journal composer.");')
assert s.count(old) == 1, "clipboard fallback nav"
s = s.replace(old, new)

# --- 3) Sources empty-state: correct copy (no composer here) + jump action ---
old = ('              <EmptyState\n'
       '                className="mt-3"\n'
       '                icon={<FileText className="size-5" />}\n'
       '                title="No sources uploaded yet"\n'
       '                description="Choose a document in the composer below to make its extracted evidence available to the Journal assistant."\n'
       '              />')
new = ('              <EmptyState\n'
       '                className="mt-3"\n'
       '                icon={<FileText className="size-5" />}\n'
       '                title="No sources uploaded yet"\n'
       '                description="Upload a document from the Timeline composer to make its extracted evidence available to the Journal assistant."\n'
       '                action={\n'
       '                  <button\n'
       '                    type="button"\n'
       '                    onClick={() => {\n'
       '                      setActiveWorkspace("timeline");\n'
       '                      window.setTimeout(() => composeRef.current?.focus(), 0);\n'
       '                    }}\n'
       '                    className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800"\n'
       '                  >\n'
       '                    Add a source\n'
       '                  </button>\n'
       '                }\n'
       '              />')
assert s.count(old) == 1, "sources empty copy"
s = s.replace(old, new)

# --- 4) Sources card: full-width bottom action bar + stronger disclosure ---
lines = s.split("\n")
# Confirm boundaries (1-indexed 598 'return (' .. 731 '    );').
assert lines[597].strip() == "return (", lines[597]
assert lines[730].strip() == ");", lines[730]
new_card = '''    return (
      <div
        key={`${source.entryId}-${source.id}`}
        className={`rounded-xl border p-4 transition-colors ${
          isExcluded
            ? "border-slate-200 bg-slate-50 opacity-75"
            : "border-slate-200 bg-white hover:border-slate-300"
        }`}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-600">
              <FileText className="size-3" /> Source
            </span>
            <span className="text-xs text-muted" title={new Date(source.created_at).toISOString()}>
              Uploaded {relativeTime(source.created_at)} by {source.entryAuthor}
            </span>
            {isExcluded ? (
              <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-800">
                Excluded from AI context
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                <CheckCircle2 className="size-3" /> In AI context
              </span>
            )}
          </div>
          <h3 className="mt-2 truncate text-sm font-semibold text-ink">
            {source.filename}
          </h3>
          <p className="mt-1 text-xs text-muted">
            {source.mime_type || "document"} · {formatFileSize(source.byte_size)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Source health</span>
            {healthBadges.map((badge) => (
              <span
                key={badge.status}
                title={badge.description}
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  badge.status === "current"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : badge.status === "conflicting"
                      ? "border-rose-200 bg-rose-50 text-rose-800"
                      : "border-amber-200 bg-amber-50 text-amber-800"
                }`}
              >
                {badge.label}
              </span>
            ))}
          </div>
        </div>
        <p className="mt-3 line-clamp-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
          {source.content_preview || "No text preview extracted."}
        </p>
        {source.entryBody && (
          <p className="mt-2 line-clamp-2 text-xs text-muted">
            Attached to journal note: {source.entryBody}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          {/* Primary source actions */}
          <button
            type="button"
            disabled={isExcluded}
            onClick={() => prepareAssistantPrompt(askAboutSourcePrompt(source.filename), [source.id], true)}
            className="inline-flex items-center gap-1 rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-800 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="size-3" /> Ask about this source
          </button>
          <button
            type="button"
            onClick={() => setSelectedSource(source)}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Preview source
          </button>
          <button
            type="button"
            onClick={() => toggleSourceExclusion(source)}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            {isExcluded ? "Include source" : "Exclude source"}
          </button>
          <details className="group relative ml-auto">
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
              More source actions
            </summary>
            <div className="absolute right-0 z-10 mt-2 flex w-60 flex-col gap-1 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
              {/* Secondary source actions */}
              <button
                type="button"
                onClick={() => toggleSourceSelection(source.id)}
                disabled={isExcluded}
                aria-pressed={isSelected && !isExcluded}
                className={`rounded-md border px-2 py-1 text-left text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  isSelected && !isExcluded
                    ? "border-violet-300 bg-violet-600 text-white"
                    : "border-violet-200 bg-white text-violet-800 hover:bg-violet-50"
                }`}
              >
                {isSelected && !isExcluded ? "Selected for batch AI" : "Select for batch AI"}
              </button>
              <button
                type="button"
                disabled={isExcluded}
                onClick={() => prepareAssistantPrompt(summarizeDocumentPrompt(source.filename), [source.id], true)}
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles className="size-3 text-violet-600" /> Summarize
              </button>
              <button
                type="button"
                disabled={isExcluded}
                onClick={() => prepareAssistantPrompt(briefUpdatePrompt(source.filename), [source.id], true)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Find supported brief updates
              </button>
              <button
                type="button"
                disabled={isExcluded}
                onClick={() => prepareAssistantPrompt(compareWithBriefPrompt(source.filename), [source.id], true)}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-left text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Compare with brief
              </button>
            </div>
          </details>
        </div>
      </div>
    );'''
lines[597:731] = new_card.split("\n")
s = "\n".join(lines)

open(p, "w").write(s)
print("fixes applied: nav-on-stage, clipboard nav, sources empty copy+action, source-card layout")
print("line count:", s.count(chr(10)) + 1)
