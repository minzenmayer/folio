// Thoughtbed · Garden audit page
//
// 2026-05-05. Shows the actual distributions + top-N tables so we can
// design the maturation system based on real data instead of guesses.

import { auditGarden } from '../audit-actions';

export const dynamic = 'force-dynamic';

function Bar({ count, max }: { count: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (count / max) * 100) : 0;
  return (
    <div className="h-1.5 bg-rule rounded-full overflow-hidden">
      <div
        className="h-full bg-ink"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function CountBlock({
  title,
  data,
}: {
  title: string;
  data: Record<string, number>;
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(0, ...entries.map((e) => e[1]));
  return (
    <div className="rounded-card border border-rule bg-paper p-5">
      <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
        {title}
      </h3>
      <ul className="flex flex-col gap-2">
        {entries.map(([k, v]) => (
          <li key={k}>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="font-sans text-[13px] text-ink">{k}</span>
              <span className="font-mono text-[11px] tracking-[0.04em] text-tag">
                {v}
              </span>
            </div>
            <Bar count={v} max={max} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function HistogramBlock({
  title,
  data,
}: {
  title: string;
  data: { bucket: string; count: number }[];
}) {
  const max = Math.max(0, ...data.map((d) => d.count));
  return (
    <div className="rounded-card border border-rule bg-paper p-5">
      <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
        {title}
      </h3>
      <ul className="flex flex-col gap-2">
        {data.map((d) => (
          <li key={d.bucket}>
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <span className="font-mono text-[12px] text-ink">{d.bucket}</span>
              <span className="font-mono text-[11px] tracking-[0.04em] text-tag">
                {d.count}
              </span>
            </div>
            <Bar count={d.count} max={max} />
          </li>
        ))}
      </ul>
    </div>
  );
}

type AuditIdea = {
  id: string;
  title: string;
  essence: string | null;
  temperature: string;
  maturity: string;
  claimKind: string;
  sourceKind: string | null;
  depthSignal: number | null;
  topicFit: number;
  composite: number;
};

function IdeasTable({
  title,
  rows,
}: {
  title: string;
  rows: AuditIdea[];
}) {
  return (
    <div className="rounded-card border border-rule bg-paper p-5">
      <h3 className="font-mono text-[10px] tracking-[0.22em] uppercase text-tag font-medium mb-3">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="font-sans text-[13px] text-tag italic">
          No ideas matched this filter.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-rule">
          {rows.map((r) => (
            <li key={r.id} className="py-2">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <a
                  href={`/studio/garden/${r.id}`}
                  className="font-sans text-[13.5px] font-medium text-ink hover:underline underline-offset-4 decoration-rule-strong line-clamp-1"
                >
                  {r.title}
                </a>
                <span className="font-mono text-[10px] tracking-[0.04em] text-tag whitespace-nowrap">
                  {r.temperature} · {r.maturity}
                </span>
              </div>
              {r.essence && (
                <p className="font-sans text-[12px] text-ink-soft leading-[1.5] line-clamp-1 mb-1">
                  {r.essence}
                </p>
              )}
              <p className="font-mono text-[10px] tracking-[0.04em] text-tag">
                depth{' '}
                {r.depthSignal !== null
                  ? r.depthSignal.toFixed(2)
                  : '—'}{' '}
                · fit {r.topicFit.toFixed(2)} · composite{' '}
                {r.composite.toFixed(2)} · {r.claimKind} ·{' '}
                {r.sourceKind ?? '—'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default async function AuditPage() {
  const audit = await auditGarden();

  return (
    <section>
      <div className="max-w-[1100px] mx-auto px-6 md:px-8 py-12">
        <div className="mb-8">
          <h1 className="font-sans text-[28px] font-semibold tracking-tight text-ink mb-2">
            Garden audit
          </h1>
          <p className="font-sans text-[14px] text-ink-soft leading-[1.55]">
            What the system actually sees in your Garden.{' '}
            <span className="font-medium text-ink">{audit.totalIdeas}</span>{' '}
            ideas in the ideas table.{' '}
            <span className="font-medium text-ink">
              {audit.totalExtracted}
            </span>{' '}
            in extracted_ideas. Positive corpus has{' '}
            <span className="font-medium text-ink">
              {audit.positiveCorpusSize}
            </span>{' '}
            embeddings (newsletter + LinkedIn + manually-claimed),
            negative corpus has{' '}
            <span className="font-medium text-ink">
              {audit.negativeCorpusSize}
            </span>{' '}
            (set-aside).
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-4 mb-6">
          <CountBlock title="By temperature" data={audit.byTemperature} />
          <CountBlock title="By maturity" data={audit.byMaturity} />
          <CountBlock title="By claim kind" data={audit.byClaimKind} />
          <CountBlock title="By source kind" data={audit.bySourceKind} />
        </div>

        <div className="grid md:grid-cols-2 gap-4 mb-6">
          <HistogramBlock
            title="Depth signal distribution"
            data={audit.depthDistribution}
          />
          <HistogramBlock
            title="Topic-fit distribution"
            data={audit.topicFitDistribution}
          />
        </div>

        <div className="grid gap-4">
          <IdeasTable
            title="Top 15 by composite (depth × topic-fit) — should be hot/ready"
            rows={audit.topByComposite}
          />
          <IdeasTable
            title="Top 15 by depth signal — most thoroughly worked"
            rows={audit.topByDepth}
          />
          <IdeasTable
            title="Top 15 by topic-fit — most like your published writing"
            rows={audit.topByTopicFit}
          />
          <IdeasTable
            title="Sample of off-topic (fit < 0.30) — verify these are noise"
            rows={audit.offTopicSample}
          />
        </div>
      </div>
    </section>
  );
}
