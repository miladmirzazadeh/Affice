#!/usr/bin/env node
// `trella mcp` turns this process into a stdio MCP server, and such a server may
// write nothing but JSON-RPC to stdout. Node's warnings go to stderr already;
// routing them explicitly keeps that true if a future dependency changes it.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  process.stderr.write(`trella: ${warning.name}: ${warning.message}\n`);
});

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  process.stderr.write(
    `trella needs Node 22.5 or newer (found ${process.versions.node}).\n`
  );
  process.exit(1);
}

await import('../dist/index.js');
