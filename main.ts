// Process entrypoint for the forge.
//
// This file owns nothing but the trial lifecycle. Every route the suite
// exercises is built by createApp() in app.ts; what remains here is the
// sequence the environment expects from any program that runs beside it:
//
//   1. bind a port the kernel picks (never 8080, which the suite owns),
//   2. tell the environment which port was bound, exactly once,
//   3. keep serving while the environment drives the suite,
//   4. ask the environment whether it has finished, and once it says so,
//      shut down with a success status.
//
// When MAKEFUN_ENV_URL is absent there is no environment to report to, so
// the server simply stays up — that is how the entry is run by hand.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

const PAUSE_BETWEEN_POLLS_MS = 200;
const PAUSE_BEFORE_RETRY_MS = 200;

/** A promise that settles after the given pause; the only clock used here. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The environment's base URL with any trailing slashes stripped, or null. */
function environmentBase(): string | null {
  const value = process.env.MAKEFUN_ENV_URL;
  if (value === undefined || value.trim() === '') return null;
  return value.replace(/\/+$/, '');
}

/**
 * Announce the bound port. The environment keeps the first registration it
 * receives and answers 409 to any later one, so a 409 is treated as success:
 * it can only mean an earlier attempt of ours already landed. Any other
 * failure is retried after a short pause, because registering late is worse
 * than registering insistently — an unregistered program scores nothing.
 */
async function announcePort(base: string, port: number): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      await reply.text();
      if (reply.ok || reply.status === 409) return;
    } catch {
      // The environment may still be coming up; fall through and retry.
    }
    await wait(PAUSE_BEFORE_RETRY_MS);
  }
}

/**
 * Poll the environment's done endpoint until it reports completion. The
 * endpoint answers immediately either way, so this is a plain poll loop:
 * ask, pause, ask again. A failed request just means "not yet".
 */
async function waitUntilDone(base: string): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${base}/done`);
      if (reply.ok) {
        const state = (await reply.json()) as { done?: unknown };
        if (state.done === true) return;
      } else {
        await reply.text();
      }
    } catch {
      // Not reachable yet or mid-restart; keep asking.
    }
    await wait(PAUSE_BETWEEN_POLLS_MS);
  }
}

async function run(): Promise<void> {
  const server = createApp();

  // Binding port 0 asks the kernel for a free ephemeral port; the number it
  // chose is read back from the server once the listen callback fires.
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) reject(new Error('server bound without an address'));
      else resolve(address.port);
    });
  });

  const base = environmentBase();
  if (base === null) {
    process.stderr.write(`[entry] serving on port ${boundPort} with no environment configured\n`);
    return; // The listening server keeps the process alive on its own.
  }

  await announcePort(base, boundPort);
  process.stderr.write(`[entry] registered port ${boundPort}; waiting for the suite to finish\n`);
  await waitUntilDone(base);

  // The run is over. Drop any lingering keep-alive sockets so the close is
  // immediate, then report success the way the lifecycle promises: exit 0.
  server.closeAllConnections();
  server.close();
  process.exit(0);
}

run().catch((err: unknown) => {
  process.stderr.write(`[entry] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
