// Thoughtbed · Footer
// Editorial colophon. Quiet, with care.

import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t border-rule mt-auto">
      <div className="max-w-[1200px] mx-auto px-[7%] py-12 font-sans text-[12px] tracking-[0.04em] text-tag">
        <p className="mb-2">
          <em className="italic">Thoughtbed.</em> Mature your mind.
        </p>
        <p className="mb-3">
          Editorial language: Fraunces, Inter, JetBrains Mono.
        </p>
        <p className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/" className="hover:text-accent transition-colors">
            Home
          </Link>
          <Link href="/sign-in" className="hover:text-accent transition-colors">
            Sign in
          </Link>
          <a
            href="https://thoughtbed.com"
            className="hover:text-accent transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            thoughtbed.com
          </a>
          <span className="ml-auto text-rule-strong">
            © {new Date().getFullYear()} Thoughtbed
          </span>
        </p>
      </div>
    </footer>
  );
}
