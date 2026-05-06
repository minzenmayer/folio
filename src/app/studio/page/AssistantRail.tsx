// Folio · AssistantRail
// The right pane on /studio/page. In Sprint 8 this becomes the live retrieval
// surface — captures, ideas, voice cues pulled from the user's own bank.
// For now it's a deliberately quiet placeholder, in the same visual register
// as the rest of the studio.

export function AssistantRail() {
  return (
    <aside
      className="border-l border-rule bg-paper/40 flex flex-col"
      aria-label="Assistant"
    >
      <div className="px-5 pt-6 pb-4 border-b border-rule">
        <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-bold mb-3">
          ▸ The closed loop
        </div>
        <p className="font-serif italic text-[14px] text-ink-soft leading-[1.5]">
          Your Inbox and Library will surface here as you write. Pulling
          captures, ideas, and your own past sentences into the margin.
        </p>
      </div>

      <div className="flex-1 px-5 py-8 flex flex-col items-start gap-3">
        <span className="inline-block font-mono text-[9px] tracking-[0.22em] uppercase text-tag bg-paper-2 border border-rule rounded-full px-3 py-1">
          Coming in Sprint 8
        </span>
        <p className="font-serif text-[13px] text-tag italic leading-[1.55]">
          The Assistant is dormant on this surface. The ground beneath it —
          embeddings of your captures, ideas, and previous drafts — is being
          laid in earlier sprints.
        </p>
      </div>
    </aside>
  );
}
