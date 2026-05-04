// Folio · Auth helper
// Resolves the current Clerk user to our internal users.id (UUID).
// Handles the race where the webhook hasn't fired yet by creating the row inline.

import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { db, users, type User } from '@/db';
import { eq } from 'drizzle-orm';

export async function requireUser(): Promise<User> {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    redirect('/sign-in');
  }

  // Fast path: row already mirrored.
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (existing) return existing;

  // Webhook hasn't fired yet — mirror inline.
  //
  // Phase 11.1 fix (2026-05-04): the prior naive INSERT ... RETURNING
  // here raced with /api/webhooks/clerk. On the very first sign-in via
  // Clerk Production, the webhook's user.created handler could land
  // between our SELECT and our INSERT, exploding on the
  // users_clerk_id_key unique constraint and 500'ing /studio. Switching
  // to an upsert lets the loser of the race fall through cleanly. The
  // SET clause refreshes email/name from Clerk on every miss too, which
  // keeps the mirror eventually-consistent without a separate sync job.
  const clerk = await currentUser();
  if (!clerk) {
    redirect('/sign-in');
  }

  const email = clerk.emailAddresses[0]?.emailAddress || '';
  const name =
    [clerk.firstName, clerk.lastName].filter(Boolean).join(' ') || null;

  const [created] = await db
    .insert(users)
    .values({ clerkId, email, name })
    .onConflictDoUpdate({
      target: users.clerkId,
      set: { email, name },
    })
    .returning();

  return created;
}
