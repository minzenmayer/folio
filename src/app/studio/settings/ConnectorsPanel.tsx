'use client';

/**
 * src/app/studio/settings/ConnectorsPanel.tsx
 *
 * Top-level panel rendered on /studio/settings that lists all available
 * connector cards.  Wave 2 adds the ObsidianCard.
 *
 * Props are resolved server-side by the parent page component;
 * this component is a pure presentational wrapper.
 */

import { BeehiivCard,  type BeehiivCardProps  } from './connectors/BeehiivCard';
import { ObsidianCard, type ObsidianCardProps } from './connectors/ObsidianCard';

export interface ConnectorsPanelProps {
  beehiiv:  BeehiivCardProps['connector'];
  obsidian: ObsidianCardProps['connector'];
}

export function ConnectorsPanel({ beehiiv, obsidian }: ConnectorsPanelProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold mb-1">Connectors</h2>
        <p className="text-sm text-muted-foreground">
          Connect data sources to populate your Knowledge base.
        </p>
      </div>

      <BeehiivCard  connector={beehiiv}  />
      <ObsidianCard connector={obsidian} />
    </div>
  );
}
