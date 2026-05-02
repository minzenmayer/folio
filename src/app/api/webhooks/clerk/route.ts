// Folio · Clerk webhook
// Mirrors Clerk users into our local users table.
// Required because our schema's foreign keys reference our internal users.id,
// not Clerk's IDs — but every Clerk user must have a corresponding row.
//
// Setup:
//   1. In Clerk Dashboard → Webhooks → Create Endpoint
//   2. Endpoint URL: https://<your-domain>/api/webhooks/clerk
//   3. Subscribe to: user.created, user.updated, user.deleted
//   4. Copy the Signing Secret → save as CLERK_WEBHOOK_SECRET in env
//
// Security: every payload is verified against the signing secret via svix.

import { headers } from 'next/headers';
import { Webhook } from 'svix';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';
import type { WebhookEvent } from '@clerk/nextjs/server';

export async function POST(req: Request) {
  const SIGNING_SECRET = process.env.CLERK_WEBHOOK_SECRET;
  if (!SIGNING_SECRET) {
    console.error('[clerk-webhook] CLERK_WEBHOOK_SECRET not set');
    return new Response('Server misconfigured', { status: 500 });
  }

  // Get the headers and body
  const headerPayload = await headers();
  const svix_id = headerPayload.get('svix-id');
  const svix_timestamp = headerPayload.get('svix-timestamp');
  const svix_signature = headerPayload.get('svix-signature');

  if (!svix_id || !svix_timestamp || !svix_signature) {
    return new Response('Missing svix headers', { status: 400 });
  }

  const payload = await req.text();
  const wh = new Webhook(SIGNING_SECRET);

  let evt: WebhookEvent;
  try {
    evt = wh.verify(payload, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    }) as WebhookEvent;
  } catch (err) {
    console.error('[clerk-webhook] verification failed', err);
    return new Response('Invalid signature', { status: 400 });
  }

  // Handle the event
  try {
    switch (evt.type) {
      case 'user.created': {
        const { id, email_addresses, first_name, last_name } = evt.data;
        const primaryEmail = email_addresses?.[0]?.email_address;
        if (!primaryEmail) break;
        const name =
          [first_name, last_name].filter(Boolean).join(' ') || null;

        await db.insert(users).values({
          clerkId: id,
          email: primaryEmail,
          name,
        });
        console.log(`[clerk-webhook] user.created mirrored: ${id}`);
        break;
      }

      case 'user.updated': {
        const { id, email_addresses, first_name, last_name } = evt.data;
        const primaryEmail = email_addresses?.[0]?.email_address;
        const name =
          [first_name, last_name].filter(Boolean).join(' ') || null;

        await db
          .update(users)
          .set({
            ...(primaryEmail && { email: primaryEmail }),
            name,
          })
          .where(eq(users.clerkId, id));
        console.log(`[clerk-webhook] user.updated mirrored: ${id}`);
        break;
      }

      case 'user.deleted': {
        const { id } = evt.data;
        if (!id) break;
        await db.delete(users).where(eq(users.clerkId, id));
        console.log(`[clerk-webhook] user.deleted cascaded: ${id}`);
        break;
      }

      default:
        // Ignore unknown event types
        break;
    }
  } catch (err) {
    console.error('[clerk-webhook] handler error', err);
    return new Response('Handler error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
}
