/**
 * What the two services print when they cannot start, as they really print it.
 *
 * 1.11 closes the causes to two — unreachable, or port occupied — and the port-occupied half is not
 * visible in an exit code: both services exit with 1. It is visible only in these texts, and the two
 * texts have nothing in common. Node, and therefore Nest, prints its error code; Vite catches the same
 * error code and replaces it with a sentence of its own, because `strictPort` in
 * `apps/web/vite.config.ts` forbids it to move to the next free port. A classification tested against
 * invented output would recognise one of them and be wrong about the other.
 */

/** `node dist/main.js` while `API_PORT` is taken. */
export const NEST_PORT_OCCUPIED_OUTPUT = [
  'node:events:496',
  '      throw er; // Unhandled "error" event',
  '      ^',
  '',
  'Error: listen EADDRINUSE: address already in use 127.0.0.1:4000',
  '    at Server.setupListenHandle [as _listen2] (node:net:1908:16)',
  '    at listenInCluster (node:net:1965:12)',
  'Emitted "error" event on Server instance at:',
  "  code: 'EADDRINUSE',",
  "  syscall: 'listen',",
  "  address: '127.0.0.1',",
  '  port: 4000',
  '',
].join('\n');

/** `vite` while `WEB_PORT` is taken and `strictPort: true`. Names no error code at all. */
export const VITE_PORT_OCCUPIED_OUTPUT = [
  '',
  '  VITE v8.3.5  ready in 214 ms',
  '',
  'error when starting dev server:',
  'Error: Port 5173 is already in use',
  '    at httpServerStart (file:///repo/node_modules/vite/dist/node/chunks/node.js:28104:24)',
  '',
].join('\n');

/** `node dist/main.js` without a build: a failure that is not about a port. */
export const MISSING_BUILD_OUTPUT = [
  'node:internal/modules/cjs/loader:1215',
  '  throw err;',
  '  ^',
  '',
  "Error: Cannot find module '/repo/apps/api/dist/main.js'",
  '    at Function._resolveFilename (node:internal/modules/cjs/loader:1212:15)',
  '',
].join('\n');

/** The API_Service refusing to start on an incomplete environment file, in its own German (1.15). */
export const API_CONFIG_INCOMPLETE_OUTPUT = [
  'Konfiguration unvollständig: Die folgenden Schlüssel fehlen in der Umgebungsdatei oder sind leer:',
  '  - ROUTING_API_KEY (nicht leer)',
  'Der API_Service wurde nicht gestartet.',
  '',
].join('\n');

/** What the API_Service answers the readiness query with once its schema is built. */
export const HEALTH_OK_BODY = '{"data":{"health":"ok"}}';
