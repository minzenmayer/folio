// Thoughtbed · /studio/voice client — Phase 15a (2026-05-05)
//
// Tabs (longform / linkedin), profile panel per platform, canonical
// list per platform, rebuild button. Manages local state for the
// manual-list editor and the rebuild flow.
//
// Spec: ~/Desktop/Thoughtbed/phase15a_voice_id_spec.md

'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from 'react';
import {
  rebuildProfile,
  setCanonical,
  unsetCanonical,
  updateManualLists,
  type RebuildProfileResult,
} from './actions';

type Platform = 'longform' | 'linkedin';

type SerializedCandidate = {
  sourceKind: 'newsletter_issue' | 'obsidian_note' | 'linkedin_post';
  id: string;
  title: string | null;
  snippet: string | null;
  postedAt: string | null;
  isCanonical: boolean;
};

type SerializedProfile = {
  summary: string | null;
  attributesAuto: string[];
  thingsToAvoidAuto: string[];
  attributesManual: string[];
  thingsToAvoidManual: string[];
  builtAt: string | null;
} | null;

type Tallies = { totalEligible: number; totalCanonical: number };

export function VoiceClient({
  longformProfile,
  linkedinProfile,
  longformCanonical,
  linkedinCanonical,
  longformTallies,
  linkedinTallies,
}: {
  longformProfile: SerializedProfile;
  linkedinProfile: SerializedProfile;
  longformCanonical: SerializedCandidate[];
  linkedinCanonical: SerializedCandidate[];
  longformTallies: Tallies;
  linkedinTallies: Tallies;
}) {
  const [platform, setPlatform] = useState<Platform>('longform');

  const profile =
    platform === 'longform' ? longformProfile : linkedinProfile;
  const candidates =
    platform === 'longform' ? longformCanonical : linkedinCanonical;
  const tallies = platform === 'longform' ? longformTallies : linkedinTallies;

  return (
    <>
      <div
        role="tablist"
        aria-label="Voice platform"
        className="flex items-center gap-1 mb-8"
      >
        <PlatformPill
          label="Longform"
          hint="newsletters + vault"
          selected={platform === 'longform'}
          onClick={() => setPlatform('longform')}
        />
        <PlatformPill
          label="LinkedIn"
          hint="short-form"
          selected={platform === 'linkedin'}
          onClick={() => setPlatform('linkedin')}
        />
      </div>

      <ProfilePanel
        platform={platform}
        profile={profile}
        canonicalCount={tallies.totalCanonical}
        eligibleCount={tallies.totalEligible}
      />

      <div className="mt-12">
        <CanonicalList
          platform={platform}
          candidates={candidates}
          tallies={tallies}
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
      className={`flex items-baseline gap-2 rounded-soft px-4 py-2 transition-colors ${
        selected
          ? 'bg-ink text-bg'
          : 'bg-paper border border-rule text-ink-soft hover:bg-paper-2 hover:text-ink'
      }`}
    >
      <span className="font-mono text-[11px] tracking-[0.18em] uppercase font-medium">
        {label}
      </span>
      <span
        className={`font-sans text-[11px] ${
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
  canonicalCount,
  eligibleCount,
}: {
  platform: Platform;
  profile: SerializedProfile;
  canonicalCount: number;
  eligibleCount: number;
}) {
  const [isRebuilding, startRebuild] = useTransition();
  const [rebuildResult, setRebuildResult] =
    useState<RebuildProfileResult | null>(null);

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
              Built {timeAgo(profile.builtAt)} from {canonicalCount}{' '}
              canonical + {Math.max(0, eligibleCount - canonicalCount)}{' '}
              recent
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
          {isRebuilding ? 'Building…' : 'Rebuild profile'}
        </button>
      </div>

      {rebuildResult && !rebuildResult.ok && (
        <div className="px-5 py-3 border-b border-rule bg-paper-2">
          <p className="font-sans text-[13px] text-ink leading-[1.5]">
            {rebuildResult.message}
          </p>
        </div>
      )}

      {!hasProfile ? (
        <div className="px-5 py-8 text-center">
          <p className="font-sans text-[14px] text-ink-soft leading-[1.55] max-w-[48ch] mx-auto">
            No profile yet. Hit Rebuild to compute one from your{' '}
            {platform === 'longform' ? 'newsletters + vault' : 'LinkedIn posts'}
            . You can also flag canonical pieces below first to bias the
            sample toward what sounds most like you.
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
        currentManual={profile.attributesManual}
        currentManualOther={profile.thingsToAvoidManual}
      />

      <div className="border-t border-rule mt-6 pt-6">
        <ListSection
          title="Things to avoid"
          autoItems={profile.thingsToAvoidAuto}
          manualItems={profile.thingsToAvoidManual}
          platform={platform}
          kind="thingsToAvoid"
          currentManual={profile.thingsToAvoidManual}
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
  currentManual,
  currentManualOther,
}: {
  title: string;
  autoItems: string[];
  manualItems: string[];
  platform: Platform;
  kind: 'attributes' | 'thingsToAvoid';
  currentManual: string[];
  currentManualOther: string[];
}) {
  const [items, setItems] = useState<string[]>(manualItems);
  const [draft, setDraft] = useState('');
  const [isSaving, startSave] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  const persist = useCallback(
    (next: string[]) => {
      setSaveError(null);
      startSave(async () => {
        try {
          await updateManualLists({
            platform,
            attributes: kind === 'attributes' ? next : currentManualOther,
            thingsToAvoid:
              kind === 'thingsToAvoid' ? next : currentManualOther,
          });
        } catch (err) {
          setSaveError(
            err instanceof Error ? err.message : 'save failed'
          );
        }
      });
    },
    [kind, platform, currentManualOther]
  );

  const onAdd = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (items.length >= 20) return;
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
            From your corpus
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
        {items.length >= 20 && (
          <p className="font-sans text-[11.5px] text-tag mt-2">
            20 items max per list.
          </p>
        )}
        {saveError && (
          <p className="font-sans text-[11.5px] text-ink mt-2">
            {saveError}
          </p>
        )}
      </div>
    </section>
  );
}

// ─── Canonical list ──────────────────────────────────────

function CanonicalList({
  platform,
  candidates: initial,
  tallies,
}: {
  platform: Platform;
  candidates: SerializedCandidate[];
  tallies: Tallies;
}) {
  const [candidates, setCandidates] =
    useState<SerializedCandidate[]>(initial);
  const [search, setSearch] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startToggle] = useTransition();

  // Re-sync local state when the parent feeds a new initial list
  // (e.g. platform switch). Effect runs after paint; keeps the
  // optimistic-toggle local state behavior.
  useEffect(() => {
    setCandidates(initial);
    setPendingId(null);
  }, [initial]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => {
      const t = (c.title ?? '').toLowerCase();
      const s = (c.snippet ?? '').toLowerCase();
      return t.includes(q) || s.includes(q);
    });
  }, [candidates, search]);

  const onToggle = (cand: SerializedCandidate) => {
    setPendingId(cand.id);
    const nextCanonical = !cand.isCanonical;
    setCandidates((prev) =>
      prev.map((c) =>
        c.id === cand.id ? { ...c, isCanonical: nextCanonical } : c
      )
    );
    startToggle(async () => {
      try {
        if (nextCanonical) {
          await setCanonical({
            sourceKind: cand.sourceKind,
            sourceId: cand.id,
          });
        } else {
          await unsetCanonical({
            sourceKind: cand.sourceKind,
            sourceId: cand.id,
          });
        }
      } catch (err) {
        // Roll back optimistic update on failure.
        setCandidates((prev) =>
          prev.map((c) =>
            c.id === cand.id
              ? { ...c, isCanonical: cand.isCanonical }
              : c
          )
        );
        console.error('[CanonicalList] toggle failed', err);
      } finally {
        setPendingId(null);
      }
    });
  };

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium">
          Canonical pieces
        </h2>
        <p className="font-sans text-[12.5px] text-ink-soft">
          {tallies.totalCanonical} canonical out of {tallies.totalEligible}
        </p>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={
          platform === 'longform'
            ? 'Search by title or snippet…'
            : 'Search posts…'
        }
        className="w-full bg-paper-2 rounded-soft border border-rule px-3 py-2 font-sans text-[13.5px] text-ink placeholder:text-tag focus:outline-none focus:border-ink mb-4"
      />

      <ul className="bg-paper rounded-card border border-rule overflow-hidden divide-y divide-rule">
        {filtered.length === 0 && (
          <li className="px-4 py-6 text-center font-sans text-[13px] text-tag italic">
            {candidates.length === 0
              ? 'No pieces in your space yet.'
              : 'Nothing matches that search.'}
          </li>
        )}
        {filtered.map((cand) => (
          <li key={`${cand.sourceKind}:${cand.id}`}>
            <button
              type="button"
              onClick={() => onToggle(cand)}
              disabled={pendingId === cand.id}
              className="w-full text-left grid grid-cols-[20px_1fr_auto] gap-3 items-baseline px-4 py-3 hover:bg-paper-2 transition-colors disabled:opacity-60"
            >
              <span
                className={`font-mono text-[14px] leading-none ${
                  cand.isCanonical ? 'text-ink' : 'text-tag'
                }`}
                aria-hidden
              >
                {cand.isCanonical ? '★' : '☆'}
              </span>
              <span className="min-w-0">
                <span className="font-sans text-[14px] text-ink leading-[1.4] block truncate">
                  {cand.title || cand.snippet || '(untitled)'}
                </span>
                {cand.snippet && cand.title && (
                  <span className="font-sans text-[12.5px] text-ink-soft leading-[1.4] block truncate mt-0.5">
                    {cand.snippet}
                  </span>
                )}
              </span>
              <span className="font-mono text-[10px] tracking-[0.04em] text-tag whitespace-nowrap">
                {kindLabel(cand.sourceKind)}
                {cand.postedAt ? ` · ${timeAgo(cand.postedAt)}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function kindLabel(kind: SerializedCandidate['sourceKind']): string {
  if (kind === 'newsletter_issue') return 'CSL';
  if (kind === 'obsidian_note') return 'vault';
  if (kind === 'linkedin_post') return 'LinkedIn';
  return kind;
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}
