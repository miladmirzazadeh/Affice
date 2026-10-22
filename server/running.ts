// Is an Affice already answering on a port? `affice` (a second start just opens the first) and `affice doctor`
// (the port check passes when the thing on the port is Affice itself) both ask. Every route needs a token, so
// the question goes without one, and the answer is the refusal that only Affice words this way. This file
// stays small and imports nothing of the server, so the doctor can use it.

import { request } from 'node:http';

/** The sentence of the 401 an Affice route sends to a request with no token. */
export const NEEDS_TOKEN = 'Affice needs its token for this route.';

/**
 * True when an Affice answers on 127.0.0.1:`port`. One request on its own connection that is closed after the
 * answer or the timeout, so asking never leaves a connection behind.
 */
export function afficeAnswers(port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/app', method: 'GET', agent: false, headers: { connection: 'close' }, timeout: timeoutMs }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        if (text.length < 4_096) text += chunk;
      });
      response.on('end', () => {
        try {
          const body = JSON.parse(text) as { error?: unknown } | null;
          resolve(response.statusCode === 401 && typeof body === 'object' && body !== null && body.error === NEEDS_TOKEN);
        } catch {
          resolve(false);
        }
      });
      response.on('error', () => resolve(false));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}
