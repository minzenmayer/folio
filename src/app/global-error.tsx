// Thoughtbed · Root error boundary
//
// Catches any throw that isn't handled by a route-level error.tsx —
// includes errors in app/layout.tsx, middleware that surfaces an
// uncaught throw, or root context providers (Clerk, etc.).

'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error]', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          padding: '64px 24px',
          maxWidth: '640px',
          margin: '0 auto',
          color: '#0a0a0a',
        }}
      >
        <h1
          style={{
            fontSize: '28px',
            fontWeight: 600,
            marginBottom: 12,
          }}
        >
          Something went wrong.
        </h1>
        <p style={{ fontSize: '15px', color: '#52525b', marginBottom: 24 }}>
          The app threw an error before it could finish rendering. Try
          reloading. If it keeps happening, the message below tells me
          what to fix.
        </p>
        <pre
          style={{
            background: '#f4f4f5',
            border: '1px solid #e4e4e7',
            borderRadius: 8,
            padding: 12,
            fontSize: 12,
            fontFamily:
              'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: 16,
          }}
        >
          {error.message || 'Unknown error.'}
          {error.digest && `\n\nDigest: ${error.digest}`}
          {error.stack && `\n\n${error.stack}`}
        </pre>
        <button
          type="button"
          onClick={reset}
          style={{
            background: '#0a0a0a',
            color: '#fafafa',
            border: 'none',
            padding: '10px 16px',
            fontSize: 11,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
