/**
 * A tiny argument parser. Trella's CLI is small and its flags are explicit, so a
 * dependency here would cost more in supply chain than it saves in code.
 */
export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

const REPEATABLE = new Set(['label']);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const equals = token.indexOf('=');
    let name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    let value: string | boolean;

    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else if (name.startsWith('no-')) {
      name = name.slice(3);
      value = false;
    } else {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }

    if (REPEATABLE.has(name)) {
      const existing = flags[name];
      const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
      list.push(String(value));
      flags[name] = list;
    } else {
      flags[name] = value;
    }
  }

  return { command, positional, flags };
}

export function flagString(
  flags: ParsedArgs['flags'],
  name: string,
  fallback?: string
): string | undefined {
  const value = flags[name];
  if (value === undefined || typeof value === 'boolean') return fallback;
  return Array.isArray(value) ? value.join(',') : value;
}

export function flagNumber(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = flagString(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function flagList(flags: ParsedArgs['flags'], name: string): string[] | undefined {
  const value = flags[name];
  if (value === undefined || typeof value === 'boolean') return undefined;
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function flagBoolean(flags: ParsedArgs['flags'], name: string): boolean | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  return value !== 'false' && value !== '0';
}
