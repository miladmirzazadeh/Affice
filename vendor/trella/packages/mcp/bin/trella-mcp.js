#!/usr/bin/env node
// A stdio MCP server may write nothing but JSON-RPC to stdout — anything else
// corrupts the stream and the client drops the connection. Node's own warnings
// already go to stderr; this listener makes that explicit and keeps the format
// recognisable in a client's error log.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  process.stderr.write(`trella-mcp: ${warning.name}: ${warning.message}\n`);
});

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  process.stderr.write(`trella needs Node 22.5 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}

const { runMcpServer } = await import('../dist/index.js');
await runMcpServer();
