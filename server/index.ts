// The entry that runs the Affice server: `tsx watch server/index.ts` in development, dist/server.js in the
// package (bin/affice.js sets the environment and imports it). The server itself is startServer in
// server/app.ts. Settings come from the environment:
//   AFFICE_PORT          the port (default 4747), always bound to 127.0.0.1
//   AFFICE_PROJECT       a project to open at start (otherwise the browser asks for one)
//   AFFICE_OPEN_BROWSER  1: open http://localhost:<port> once the server listens (bin/affice.js sets it)
// Shutdown (SIGINT, SIGTERM) stops the manager sessions and the Trella service first.

import { PortInUseError, startServer, type RunningServer } from './app';
import { openBrowser } from './open-browser';
import { afficeAnswers } from './running';
import { afficeVersion, serverPort } from './runtime';

const log = (line: string) => console.log(`[affice] ${line}`);

async function main(): Promise<void> {
  const port = serverPort();
  const wantsBrowser = process.env.AFFICE_OPEN_BROWSER === '1';
  let running: RunningServer;
  try {
    running = await startServer({ port });
  } catch (error) {
    if (error instanceof PortInUseError) {
      if (await afficeAnswers(port)) {
        log(`Affice is already running at http://localhost:${port}`);
        if (wantsBrowser) openBrowser(`http://localhost:${port}`);
        return;
      }
      console.error(`[affice] Port ${port} is in use by another program. Start Affice on another port: affice --port <number>`);
      process.exit(1);
    }
    throw error;
  }

  console.log(`\n  Affice ${afficeVersion()}\n  Open ${running.url}${running.servesClient ? '' : '  (there is no built page here: use npx --yes affice@latest, or run npm run build in a clone)'}\n  Press Ctrl+C to stop.\n`);
  if (wantsBrowser && running.servesClient) openBrowser(running.url);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log(`${signal}: stopping the manager sessions and Trella`);
    const force = setTimeout(() => process.exit(0), 12_000);
    force.unref();
    running
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// The server outlives any one failure: a bad frame, a crashed manager, a throwing data route.
process.on('uncaughtException', (error) => console.error('[affice] uncaught:', error));
process.on('unhandledRejection', (error) => console.error('[affice] unhandled rejection:', error));

main().catch((error) => {
  console.error('[affice] failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
