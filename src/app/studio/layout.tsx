// Thoughtbed · Studio layout
// The authed shell. Wraps every protected route under /studio with a
// masthead carrying the Clerk UserButton.

import { UserButton } from '@clerk/nextjs';
import { Footer } from '@/components/Footer';
import Link from 'next/link';

export default function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-rule">
        <div className="max-w-[1200px] mx-auto px-[7%] py-7 flex justify-between items-center gap-4">
          <Link
            href="/studio"
            className="font-serif italic text-[22px] text-ink font-medium hover:text-accent transition-colors"
            aria-label="Thoughtbed — home"
          >
            Thoughtbed
          </Link>
          <nav className="flex items-center gap-6" aria-label="Thoughtbed navigation">
            <Link
              href="/studio"
              className="font-sans text-[12px] tracking-[0.04em] text-ink-soft hover:text-accent transition-colors"
            >
              Write
            </Link>
            <Link
              href="/studio/inbox"
              className="font-sans text-[12px] tracking-[0.04em] text-ink-soft hover:text-accent transition-colors"
            >
              Inbox
            </Link>
            <Link
              href="/studio/ideas"
              className="font-sans text-[12px] tracking-[0.04em] text-ink-soft hover:text-accent transition-colors"
            >
              Garden
            </Link>
            <Link
              href="/studio/knowledge"
              className="font-sans text-[12px] tracking-[0.04em] text-ink-soft hover:text-accent transition-colors"
            >
              Knowledge
            </Link>
            <UserButton
              appearance={{
                elements: {
                  avatarBox: 'w-8 h-8 ring-1 ring-rule',
                },
              }}
            />
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <Footer />
    </div>
  );
}
