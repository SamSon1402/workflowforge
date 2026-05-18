import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { cronScanner, eventTrigger } from '@/inngest/functions';

/**
 * Inngest webhook. The Inngest CLI dev server (or production cloud)
 * POSTs to this endpoint to invoke our registered functions.
 *
 * Run `npx inngest-cli@latest dev` in another terminal during local
 * development; it auto-discovers this URL.
 */

export const runtime = 'nodejs';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [cronScanner, eventTrigger],
});
