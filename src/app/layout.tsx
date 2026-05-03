import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

// Sprint 14 brand pivot: Fraunces is gone. The product is Inter
// (system sans) for body and chrome, JetBrains Mono for system labels
// (NEW POST, RETRAIN, etc. — Ghostbase's mono-uppercase pattern).

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Thoughtbed — A writing studio that knows your voice.',
  description:
    'Thoughtbed is a private writing studio. Capture, mature, and ship ideas in your own voice.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${inter.variable} ${jetbrains.variable}`}
      >
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
