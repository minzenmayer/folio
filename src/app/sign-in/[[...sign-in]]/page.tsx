// Folio · Sign-in (Clerk)
// The Clerk <SignIn /> component dropped inside our editorial card.
// All state, validation, magic-link delivery, and routing handled by Clerk.

import { SignIn } from '@clerk/nextjs';
import Link from 'next/link';
import { Masthead } from '@/components/Masthead';
import { Footer } from '@/components/Footer';

export default function SignInPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Masthead rightSlot="Sign in to your folio" />

      <section className="flex-1 flex items-center">
        <div className="max-w-[1200px] mx-auto px-[7%] py-20 w-full">
          <div className="max-w-[440px] mx-auto">
            <div className="text-center mb-8">
              <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-4">
                ▸ Welcome back
              </div>
              <h1 className="font-serif font-normal text-[40px] leading-[1.05] tracking-tighter text-ink">
                Open your{' '}
                <em className="italic font-light text-accent">folio.</em>
              </h1>
            </div>

            <SignIn
              appearance={{
                variables: {
                  colorPrimary: '#b8331f',
                  colorBackground: '#fbf7ef',
                  colorInputBackground: '#f6f1e8',
                  colorText: '#15110c',
                  colorTextSecondary: '#3b342a',
                  colorTextOnPrimaryBackground: '#f6f1e8',
                  colorDanger: '#b8331f',
                  fontFamily: 'var(--font-serif), Georgia, serif',
                  fontSize: '15px',
                  borderRadius: '3px',
                },
                elements: {
                  rootBox: 'w-full',
                  card: 'bg-paper border border-rule shadow-none rounded-[3px] px-8 py-10',
                  headerTitle: 'hidden',
                  headerSubtitle:
                    'font-serif italic text-ink-soft text-[15px]',
                  socialButtonsBlockButton:
                    'border border-rule-strong rounded-[3px] hover:bg-paper-2',
                  formFieldLabel:
                    'font-sans text-[10px] tracking-[0.18em] uppercase font-bold text-tag',
                  formFieldInput:
                    'bg-bg border border-rule-strong rounded-[3px] font-serif text-[16px] text-ink focus:border-accent',
                  formButtonPrimary:
                    'bg-ink hover:bg-accent text-bg font-sans text-[11px] tracking-[0.18em] uppercase font-bold rounded-[3px] py-3 normal-case',
                  footerActionText: 'font-sans text-tag text-[12px]',
                  footerActionLink:
                    'font-sans text-accent italic hover:underline underline-offset-4',
                  identityPreviewText: 'font-serif text-ink',
                  identityPreviewEditButton:
                    'text-accent hover:text-accent-2',
                },
              }}
              path="/sign-in"
              signUpUrl="/sign-up"
              forceRedirectUrl="/studio"
            />

            <p className="font-serif text-[15px] text-center mt-8 text-ink-soft">
              Don't have a folio yet?{' '}
              <Link
                href="/sign-up"
                className="text-accent italic hover:underline underline-offset-4"
              >
                Open one →
              </Link>
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
