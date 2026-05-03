// Folio · Sign-up (Clerk)
// The Clerk <SignUp /> component dropped inside our editorial card.

import { SignUp } from '@clerk/nextjs';
import Link from 'next/link';
import { Masthead } from '@/components/Masthead';
import { Footer } from '@/components/Footer';

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Masthead rightSlot="Plant a new bed" />

      <section className="flex-1 flex items-center">
        <div className="max-w-[1200px] mx-auto px-[7%] py-20 w-full">
          <div className="max-w-[440px] mx-auto">
            <div className="text-center mb-8">
              <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-accent font-bold mb-4">
                ☘ A new bed
              </div>
              <h1 className="font-serif font-normal text-[40px] leading-[1.05] tracking-tighter text-ink mb-3">
                Plant your{' '}
                <em className="italic font-light text-accent">first seed.</em>
              </h1>
              <p className="font-serif italic text-[15px] text-ink-soft leading-[1.5]">
                One email. We'll send a magic link to start.
              </p>
            </div>

            <SignUp
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
                  headerSubtitle: 'hidden',
                  socialButtonsBlockButton:
                    'border border-rule-strong rounded-[3px] hover:bg-paper-2',
                  formFieldLabel:
                    'font-sans text-[10px] tracking-[0.18em] uppercase font-bold text-tag',
                  formFieldInput:
                    'bg-bg border border-rule-strong rounded-[3px] font-serif text-[16px] text-ink focus:border-accent',
                  formButtonPrimary:
                    'bg-accent hover:bg-ink text-bg font-sans text-[11px] tracking-[0.18em] uppercase font-bold rounded-[3px] py-3 normal-case',
                  footerActionText: 'font-sans text-tag text-[12px]',
                  footerActionLink:
                    'font-sans text-accent italic hover:underline underline-offset-4',
                },
              }}
              path="/sign-up"
              signInUrl="/sign-in"
              forceRedirectUrl="/studio"
            />

            <p className="font-serif text-[15px] text-center mt-8 text-ink-soft">
              Already have one?{' '}
              <Link
                href="/sign-in"
                className="text-accent italic hover:underline underline-offset-4"
              >
                Sign in →
              </Link>
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
