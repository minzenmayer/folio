// Thoughtbed · /studio/voice client — Phase 15 Voice ID UX rework
//
// 5-sample-picker model. The user picks up to 5 training samples per
// platform (corpus refs, pasted text, uploaded text), then hits
// Retrain. profileVault runs on those samples exclusively.
//
// Layout:
//   - Platform tabs (Longform / Short form)
//   - Voice profile card (summary + auto attributes + manual additions)
//     plus Retrain button + last-built timestamp
//   - Training samples panel (the new thing): up to 5 sample cards
//     with expand-to-read + remove. Add-sample modal beneath.

'use client';

import {
  useCallback,
  useEffect,
  useState,
  useTransition,
} from 'react';
import {
  rebuildProfile,
  addTrainingSample,
  removeTrainingSample,
  searchCorpusForTraining,
  getTrainingSampleBody,
  updateManualLists,
  type RebuildProfileResult,
  type ListedSample,
  type CorpusSearchResult,
  type AddSampleResult,
} from './actions';

type Platform = 'longform' | 'linkedin';

type SerializedProfile = {
  summary: string | null;
  attributesAuto: string[];
  thingsToAvoidAuto: string[];
  attributesManual: string[];
  thingsToAvoidManual: string[];
  builtAt: string | null;
} | null;

const MAX_SAMPLES = 5;

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function kindBadge(kind: ListedSample['kind'], sourceKind: string | null): string {
  if (kind === 'paste') return 'Pasted';
  if (kind === 'upload') return 'Uploaded';
  if (sourceKind === 'newsletter_issue') return 'CSL';
  if (sourceKind === 'obsidian_note') return 'Vault';
  if (sourceKind === 'linkedin_post') return 'LinkedIn';
  return 'Sample';
}

export function VoiceClient({
  longformProfile,
  linkedinProfile,
  longformSamples,
  linkedinSamples,
}: {
  longformProfile: SerializedProfile;
  linkedinProfile: SerializedProfile;
  longformSamples: ListedSample[];
  linkedinSamples: ListedSample[];
}) {
  const [platform, setPlatform] = useState<Platform>('longform');

  const profile = platform === 'longform' ? longformProfile : linkedinProfile;
  const initialSamples =
    platform === 'longform' ? longformSamples : linkedinSamples;

  return (
    <>
      <div role="tablist" aria-label="Voice platform" className="flex flex-col sm:flex-row gap-2 mb-8">
        <PlatformPill
          label="Longform"
          hint="newsletters + vault"
          selected={platform === 'longform'}
          onClick={() => setPlatform('longform')}
        />
        <PlatformPill
          label="Short form"
          hint="social posts"
          selected={platform === 'linkedin'}
          onClick={() => setPlatform('linkedin')}
        />
      </div>

      <ProfilePanel platform={platform} profile={profile} />

      <div className="mt-12">
        <TrainingSamplesPanel
          key={platform}
          platform={platform}
          initialSamples={initialSamples}
        />
      </div>
    </>
  );
}

// ─── Platform pills ──────────────────────────────────────

function PlatformPill({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`flex-1 text-left rounded-card px-5 py-4 transition-colors border ${
        selected
          ? 'bg-ink text-bg border-ink'
          : 'bg-paper border-rule text-ink-soft hover:bg-paper-2 hover:text-ink hover:border-ink/40'
      }`}
    >
      <span className="block font-sans text-[20px] font-semibold tracking-tight leading-tight">
        {label}
      </span>
      <span
        className={`block font-sans text-[12.5px] mt-0.5 ${
          selected ? 'text-bg/70' : 'text-tag'
        }`}
      >
        {hint}
      </span>
    </button>
  );
}

// ─── Profile panel ───────────────────────────────────────

function ProfilePanel({
  platform,
  profile,
}: {
  platform: Platform;
  profile: SerializedProfile;
}) {
  const [isRebuilding, startRebuild] = useTransition();
  const [rebuildResult, setRebuildResult] = useState<RebuildProfileResult | null>(null);

  const onRebuild = useCallback(() => {
    setRebuildResult(null);
    startRebuild(async () => {
      try {
        const r = await rebuildProfile({ platform });
        setRebuildResult(r);
      } catch (err) {
        setRebuildResult({
          ok: false,
          reason: 'error',
          message: err instanceof Error ? err.message : 'rebuild failed',
        });
      }
    });
  }, [platform]);

  const hasProfile =
    profile && (profile.summary || profile.attributesAuto.length > 0);

  return (
    <div className="bg-paper rounded-card border border-rule">
      <div className="px-5 py-4 border-b border-rule flex items-baseline justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-1">
            Voice profile
          </h2>
          {profile?.builtAt ? (
            <p className="font-sans text-[12.5px] text-ink-soft">
              Built {timeAgo(profile.builtAt)}
            </p>
          ) : (
            <p className="font-sans text-[12.5px] text-tag italic">
              Not built yet
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onRebuild}
          disabled={isRebuilding}
          className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft disabled:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          {isRebuilding ? 'Training…' : 'Retrain'}
        </button>
      </div>

      {rebuildResult && !rebuildResult.ok && (
        <div className="px-5 py-4 border-b border-rule bg-paper-2">
          <p className="font-mono text-[10px] tracking-[0.18em] uppercase text-tag font-medium mb-1">
            {rebuildResult.reason === 'too_sparse'
              ? 'Need a sample first'
              : 'Retrain failed'}
          </p>
          <p className="font-sans text-[13.5px] text-ink leading-[1.5]">
            {rebuildResult.message}
          </p>
        </div>
      )}
      {rebuildResult && rebuildResult.ok && (
        <div className="px-5 py-3 border-b border-rule bg-paper-2">
          <p className="font-sans text-[13px] text-ink leading-[1.5]">
            Profile retrained on {rebuildResult.sampleCount} sample
            {rebuildResult.sampleCount === 1 ? '' : 's'}.
          </p>
        </div>
      )}

      {!hasProfile ? (
        <div className="px-5 py-7">
          <p className="font-sans text-[14px] text-ink-soft leading-[1.55] max-w-[58ch]">
            No profile yet. Add up to five training samples below, then
            hit Retrain.
          </p>
        </div>
      ) : (
        <ProfileContent platform={platform} profile={profile!} />
      )}
    </div>
  );
}

function ProfileContent({
  platform,
  profile,
}: {
  platform: Platform;
  profile: NonNullable<SerializedProfile>;
}) {
  return (
    <div className="px-5 py-5">
      {profile.summary && (
        <section className="mb-6">
          <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-2">
            Summary
          </h3>
          <p className="font-sans text-[14.5px] leading-[1.6] text-ink">
            {profile.summary}
          </p>
        </section>
      )}

      <ListSection
        title="Attributes"
        autoItems={profile.attributesAuto}
        manualItems={profile.attributesManual}
        platform={platform}
        kind="attributes"
        currentManualOther={profile.thingsToAvoidManual}
      />

      <div className="border-t border-rule mt-6 pt-6">
        <ListSection
          title="Things to avoid"
          autoItems={profile.thingsToAvoidAuto}
          manualItems={profile.thingsToAvoidManual}
          platform={platform}
          kind="thingsToAvoid"
          currentManualOther={profile.attributesManual}
        />
      </div>
    </div>
  );
}

function ListSection({
  title,
  autoItems,
  manualItems,
  platform,
  kind,
  currentManualOther,
}: {
  title: string;
  autoItems: string[];
  manualItems: string[];
  platform: Platform;
  kind: 'attributes' | 'thingsToAvoid';
  currentManualOther: string[];
}) {
  const [items, setItems] = useState<string[]>(manualItems);
  const [draft, setDraft] = useState('');
  const [isSaving, startSave] = useTransition();

  const persist = useCallback(
    (next: string[]) => {
      startSave(async () => {
        try {
          await updateManualLists({
            platform,
            attributes: kind === 'attributes' ? next : currentManualOther,
            thingsToAvoid: kind === 'thingsToAvoid' ? next : currentManualOther,
          });
        } catch (err) {
          console.error('[ListSection] save failed', err);
        }
      });
    },
    [kind, platform, currentManualOther]
  );

  const onAdd = () => {
    const trimmed = draft.trim();
    if (!trimmed || items.length >= 20) return;
    const next = [...items, trimmed];
    setItems(next);
    setDraft('');
    persist(next);
  };

  const onRemove = (idx: number) => {
    const next = items.filter((_, i) => i !== idx);
    setItems(next);
    persist(next);
  };

  return (
    <section>
      <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
        {title}
      </h3>

      {autoItems.length > 0 && (
        <div className="mb-4">
          <p className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag mb-2">
            From your samples
          </p>
          <ul className="flex flex-col gap-1.5">
            {autoItems.map((item, i) => (
              <li
                key={`auto-${i}`}
                className="font-sans text-[14px] leading-[1.45] text-ink"
              >
                · {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="font-mono text-[9px] tracking-[0.18em] uppercase text-tag mb-2">
          Your additions{isSaving ? ' (saving…)' : ''}
        </p>
        {items.length > 0 && (
          <ul className="flex flex-col gap-1.5 mb-3">
            {items.map((item, i) => (
              <li
                key={`manual-${i}`}
                className="font-sans text-[14px] leading-[1.45] text-ink flex items-baseline gap-2"
              >
                <span className="flex-1">+ {item}</span>
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={`Remove "${item}"`}
                  className="font-mono text-[10px] tracking-[0.04em] text-tag hover:text-ink"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onAdd();
              }
            }}
            placeholder={
              kind === 'attributes'
                ? 'Add an attribute…'
                : 'Add something to avoid…'
            }
            className="flex-1 bg-paper-2 rounded-soft border border-rule px-3 py-2 font-sans text-[13.5px] text-ink placeholder:text-tag focus:outline-none focus:border-ink"
            disabled={items.length >= 20}
          />
          <button
            type="button"
            onClick={onAdd}
            disabled={!draft.trim() || items.length >= 20}
            className="font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-3 py-2 border border-rule hover:border-ink hover:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors"
          >
            Add
          </button>
        </div>
      </div>
    </section>
  );
}

// ─── Training samples panel ──────────────────────────────

function TrainingSamplesPanel({
  platform,
  initialSamples,
}: {
  platform: Platform;
  initialSamples: ListedSample[];
}) {
  const [samples, setSamples] = useState<ListedSample[]>(initialSamples);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [, startMutate] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const atCap = samples.length >= MAX_SAMPLES;

  const onRemove = (id: string) => {
    setError(null);
    setSamples((prev) => prev.filter((s) => s.id !== id));
    startMutate(async () => {
      try {
        await removeTrainingSample({ id });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'remove failed');
      }
    });
  };

  const onSampleAdded = (added: ListedSample) => {
    setSamples((prev) => [...prev, added]);
  };

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
            Training samples
          </h2>
          <p className="font-sans text-[12.5px] text-ink-soft mt-1">
            {samples.length}/{MAX_SAMPLES} picked. Pick the pieces that
            sound most like you.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={atCap}
          className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 border border-rule hover:border-ink hover:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          + Add sample
        </button>
      </div>

      {error && (
        <p className="font-sans text-[13px] text-ink leading-[1.5] mb-3">
          {error}
        </p>
      )}

      {samples.length === 0 ? (
        <div className="bg-paper rounded-card border border-rule px-5 py-8 text-center">
          <p className="font-sans text-[14px] text-ink-soft leading-[1.55] max-w-[52ch] mx-auto">
            No samples yet. Pick up to five pieces of writing that sound
            like you, then hit Retrain above.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {samples.map((s) => (
            <SampleCard key={s.id} sample={s} onRemove={() => onRemove(s.id)} />
          ))}
        </ul>
      )}

      {pickerOpen && (
        <AddSampleModal
          platform={platform}
          onClose={() => setPickerOpen(false)}
          onAdded={onSampleAdded}
        />
      )}
    </div>
  );
}

function SampleCard({
  sample,
  onRemove,
}: {
  sample: ListedSample;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);

  const onToggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!body) {
      setLoadingBody(true);
      try {
        const r = await getTrainingSampleBody({ id: sample.id });
        setBody(r.body);
      } catch (err) {
        console.error('[SampleCard] body fetch failed', err);
        setBody('(failed to load full content)');
      } finally {
        setLoadingBody(false);
      }
    }
    setExpanded(true);
  };

  return (
    <li className="bg-paper rounded-card border border-rule overflow-hidden">
      <div className="px-4 py-3 flex items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-sans text-[14px] text-ink leading-[1.4] font-medium truncate">
            {sample.title}
          </p>
          {!expanded && sample.snippet && (
            <p className="font-sans text-[12.5px] text-ink-soft leading-[1.5] mt-1 line-clamp-2">
              {sample.snippet}
            </p>
          )}
        </div>
        <span className="font-mono text-[10px] tracking-[0.06em] uppercase text-tag whitespace-nowrap">
          {kindBadge(sample.kind, sample.sourceKind)}
        </span>
      </div>
      <div className="px-4 pb-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
        >
          {expanded ? 'Collapse' : loadingBody ? 'Loading…' : 'Read'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors ml-auto"
        >
          Remove
        </button>
      </div>
      {expanded && body !== null && (
        <div className="border-t border-rule px-4 py-4 max-h-[420px] overflow-y-auto">
          <p className="font-sans text-[13.5px] text-ink leading-[1.65] whitespace-pre-wrap">
            {body}
          </p>
        </div>
      )}
    </li>
  );
}

// ─── Add sample modal (Corpus / Paste / Upload tabs) ─────

function AddSampleModal({
  platform,
  onClose,
  onAdded,
}: {
  platform: Platform;
  onClose: () => void;
  onAdded: (sample: ListedSample) => void;
}) {
  const [tab, setTab] = useState<'corpus' | 'paste' | 'upload'>('corpus');

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-sample-title"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[1px] cursor-default"
      />
      <div className="relative bg-paper rounded-modal shadow-modal w-full max-w-[760px] h-[min(640px,90vh)] flex flex-col overflow-hidden">
        <div className="px-6 pt-6 pb-3 border-b border-rule flex items-baseline justify-between">
          <h2
            id="add-sample-title"
            className="font-sans text-[18px] font-semibold tracking-tight text-ink"
          >
            Add a training sample
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[10px] tracking-[0.16em] uppercase text-tag hover:text-ink transition-colors"
          >
            Close
          </button>
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label="Sample source" className="flex border-b border-rule px-6">
          <TabButton selected={tab === 'corpus'} onClick={() => setTab('corpus')}>
            From your space
          </TabButton>
          <TabButton selected={tab === 'paste'} onClick={() => setTab('paste')}>
            Paste text
          </TabButton>
          <TabButton selected={tab === 'upload'} onClick={() => setTab('upload')}>
            Upload file
          </TabButton>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === 'corpus' && (
            <CorpusPickerTab
              platform={platform}
              onAdded={(s) => {
                onAdded(s);
                onClose();
              }}
            />
          )}
          {tab === 'paste' && (
            <PasteTab
              platform={platform}
              onAdded={(s) => {
                onAdded(s);
                onClose();
              }}
            />
          )}
          {tab === 'upload' && <UploadComingSoonTab />}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`font-sans text-[13.5px] px-4 py-3 -mb-px border-b-2 transition-colors ${
        selected
          ? 'border-ink text-ink'
          : 'border-transparent text-tag hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function CorpusPickerTab({
  platform,
  onAdded,
}: {
  platform: Platform;
  onAdded: (s: ListedSample) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CorpusSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Debounced search.
  useEffect(() => {
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await searchCorpusForTraining({
          platform,
          query: query.trim() || undefined,
          limit: 50,
        });
        setResults(r.results);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'search failed');
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [platform, query]);

  const onPick = async (item: CorpusSearchResult) => {
    if (item.alreadySelected) return;
    setAdding(`${item.sourceKind}:${item.id}`);
    setError(null);
    try {
      const r: AddSampleResult = await addTrainingSample({
        platform,
        kind: 'corpus',
        sourceKind: item.sourceKind,
        sourceId: item.id,
      });
      if (r.ok) {
        onAdded({
          id: r.sampleId,
          platform,
          kind: 'corpus',
          sourceKind: item.sourceKind,
          title: item.title,
          snippet: item.snippet,
          position: 0,
          createdAt: new Date().toISOString(),
        });
      } else {
        setError(r.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'add failed');
    } finally {
      setAdding(null);
    }
  };

  const sourceLabel = (sk: CorpusSearchResult['sourceKind']) =>
    sk === 'newsletter_issue' ? 'CSL' : sk === 'obsidian_note' ? 'Vault' : 'LinkedIn';

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search your pieces…"
        className="w-full bg-paper-2 rounded-soft border border-rule px-3 py-2 font-sans text-[13.5px] text-ink placeholder:text-tag focus:outline-none focus:border-ink mb-4"
      />
      {error && (
        <p className="font-sans text-[13px] text-ink leading-[1.5] mb-3">
          {error}
        </p>
      )}
      {loading && results.length === 0 ? (
        <p className="font-sans text-[13px] text-tag italic">Loading…</p>
      ) : results.length === 0 ? (
        <p className="font-sans text-[13px] text-tag italic">
          {query.trim()
            ? 'Nothing matches that search.'
            : 'No pieces in your space yet. Connect more sources or paste text instead.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {results.map((r) => {
            const isPreviewing = previewing === r.id;
            const isAdding = adding === `${r.sourceKind}:${r.id}`;
            return (
              <li
                key={`${r.sourceKind}:${r.id}`}
                className={`rounded-soft border border-rule overflow-hidden ${r.alreadySelected ? 'opacity-50' : 'hover:border-ink/40'}`}
              >
                <div className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => setPreviewing(isPreviewing ? null : r.id)}
                    className="text-left min-w-0"
                    disabled={r.alreadySelected}
                  >
                    <p className="font-sans text-[14px] text-ink leading-[1.4] font-medium truncate">
                      {r.title}
                    </p>
                    <p className="font-sans text-[12.5px] text-ink-soft leading-[1.5] mt-0.5 line-clamp-2">
                      {r.snippet ?? ''}
                    </p>
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-[10px] tracking-[0.06em] uppercase text-tag">
                      {sourceLabel(r.sourceKind)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onPick(r)}
                      disabled={r.alreadySelected || isAdding}
                      className="font-mono text-[10px] tracking-[0.16em] uppercase rounded-soft px-3 py-1.5 border border-rule hover:border-ink hover:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors"
                    >
                      {r.alreadySelected ? 'Added' : isAdding ? 'Adding…' : 'Add'}
                    </button>
                  </div>
                </div>
                {isPreviewing && r.snippet && (
                  <div className="border-t border-rule px-3 py-3 bg-paper-2 max-h-[280px] overflow-y-auto">
                    <p className="font-sans text-[13px] text-ink leading-[1.6] whitespace-pre-wrap">
                      {r.snippet}
                      <span className="text-tag italic">
                        {r.snippet.length >= 280 ? ' …' : ''}
                      </span>
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PasteTab({
  platform,
  onAdded,
}: {
  platform: Platform;
  onAdded: (s: ListedSample) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  const canAdd = trimmedTitle.length > 0 && trimmedBody.length >= 20;

  const onAdd = async () => {
    if (!canAdd) return;
    setAdding(true);
    setError(null);
    try {
      const r: AddSampleResult = await addTrainingSample({
        platform,
        kind: 'paste',
        title: trimmedTitle,
        body: trimmedBody,
      });
      if (r.ok) {
        onAdded({
          id: r.sampleId,
          platform,
          kind: 'paste',
          sourceKind: null,
          title: trimmedTitle,
          snippet: trimmedBody.slice(0, 280),
          position: 0,
          createdAt: new Date().toISOString(),
        });
      } else {
        setError(r.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'add failed');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <p className="font-sans text-[13px] text-ink-soft leading-[1.55] mb-4">
        Paste a piece of writing that sounds like you. Anything not in
        your connected sources is fair game.
      </p>
      <div className="mb-3">
        <label className="block font-mono text-[10px] tracking-[0.18em] uppercase text-tag mb-1">
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="A short label so you can recognize it later"
          maxLength={200}
          className="w-full bg-paper-2 rounded-soft border border-rule px-3 py-2 font-sans text-[13.5px] text-ink placeholder:text-tag focus:outline-none focus:border-ink"
        />
      </div>
      <div className="mb-4">
        <label className="block font-mono text-[10px] tracking-[0.18em] uppercase text-tag mb-1">
          Text
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          placeholder="Paste the full piece here…"
          className="w-full bg-paper-2 rounded-soft border border-rule px-3 py-2 font-sans text-[13.5px] text-ink placeholder:text-tag focus:outline-none focus:border-ink resize-y"
        />
        <p className="font-sans text-[11.5px] text-tag mt-1">
          {trimmedBody.length} chars (min 20)
        </p>
      </div>
      {error && (
        <p className="font-sans text-[13px] text-ink leading-[1.5] mb-3">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onAdd}
          disabled={!canAdd || adding}
          className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium rounded-soft px-4 py-2 bg-ink text-bg hover:bg-ink-soft disabled:bg-paper-2 disabled:text-tag disabled:cursor-not-allowed transition-colors"
        >
          {adding ? 'Adding…' : 'Add sample'}
        </button>
      </div>
    </div>
  );
}

function UploadComingSoonTab() {
  return (
    <div className="text-center py-12">
      <p className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
        Soon
      </p>
      <p className="font-sans text-[14px] text-ink-soft leading-[1.6] max-w-[44ch] mx-auto">
        File upload (PDF, .docx, .txt, .md) is coming next. For now,
        copy the text and paste it under the Paste tab.
      </p>
    </div>
  );
}

