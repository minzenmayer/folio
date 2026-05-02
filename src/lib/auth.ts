// Folio · Auth helper
// Resolves the current Clerk user to our internal users.id (UUID).
// Handles the race where the webhook hasn't fired yet by creating the row inline.

import { auth, currentUser } from '@clerk/nextjs/server';
import { db, users, type User } from '@/db';
import { eq } from 'drizzle-orm';

export async function requireUser(): Promise<User> {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    throw new Error('Not authenticated');
  }

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (existing) return existing;

  // Webhook hasn't fired yet — mirror inline.
  const clerk = await currentUser();
  if (!clerk) throw new Error('Clerk user not resolvable');

  const email = clerk.emailAddresses[0]?.emailAddress || '';
  const name =
    [clerk.firstName, clerk.lastName].filter(Boolean).join(' ') || null;

  const [created] = await db
    .insert(users)
    .values({ clerkId, email, name })
    .returning();

  return created;
}
