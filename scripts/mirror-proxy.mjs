#!/usr/bin/env node
// Tiny HTTPS CONNECT proxy for beatmap mirror downloads (osu-render MIRROR_PROXY).
// It only tunnels to an allowlist of hosts on port 443 and should listen on a private address (e.g. a Tailscale IP).
// Zero dependencies. Settings (environment):
//   MIRROR_PROXY_LISTEN  host:port to listen on (required, e.g. 100.121.52.116:8319)
//   MIRROR_PROXY_ALLOW   comma-separated hostnames (default: the osu-render built-in mirrors)
//   MIRROR_PROXY_MAX     max concurrent tunnels (default 16)
//   MIRROR_PROXY_IDLE_MS idle timeout per tunnel in ms (default 120000)
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

// Hosts of the built-in osu-render mirrors, plus storage.osu.direct where osu.direct redirects downloads.
export const DEFAULT_ALLOW = ['catboy.best', 'beatconnect.io', 'mirror.hinamizawa.ai', 'osu.direct', 'storage.osu.direct'];

/** Parses `host:port` of a CONNECT request; returns null for anything but a plain hostname on an allowed port. */
export function parseConnectTarget(target, ports = [443]) {
  if (typeof target !== 'string') return null;
  const match = /^([a-z0-9.-]{1,253}):(\d{1,5})$/i.exec(target.trim());
  if (!match || !ports.includes(Number(match[2])) || net.isIP(match[1])) return null;
  return { host: match[1].toLowerCase().replace(/\.$/, ''), port: Number(match[2]) };
}

/** True when `host` is exactly an allowlisted name (no subdomain or suffix tricks). */
export function isAllowed(host, allow) {
  return allow.includes(host);
}

export function parseListen(value) {
  const match = /^(.+):(\d{1,5})$/.exec(value ?? '');
  if (!match) throw new Error('MIRROR_PROXY_LISTEN must be host:port');
  return { host: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2]) };
}

export function createProxy({ allow = DEFAULT_ALLOW, ports = [443], max = 16, idleMs = 120_000, log = () => {} } = {}) {
  let open = 0;
  const server = http.createServer((_request, response) => {
    response.writeHead(405, { Allow: 'CONNECT', Connection: 'close' }).end('CONNECT only\n');
  });
  server.on('connect', (request, client, head) => {
    const target = parseConnectTarget(request.url, ports);
    const refuse = (status, reason) => {
      log({ event: 'refused', target: request.url, reason });
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    if (!target || !isAllowed(target.host, allow)) return refuse('403 Forbidden', 'not allowed');
    if (open >= max) return refuse('503 Service Unavailable', 'busy');
    open += 1;
    const upstream = net.connect(target.port, target.host);
    let closed = false;
    let established = false;
    const close = () => {
      if (closed) return;
      closed = true;
      open -= 1;
      upstream.destroy();
      client.destroy();
    };
    upstream.setTimeout(idleMs, close);
    client.setTimeout(idleMs, close);
    upstream.once('connect', () => {
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      log({ event: 'tunnel', host: target.host });
    });
    upstream.on('error', (error) => {
      if (!established && !client.writableEnded) client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      log({ event: 'upstream_error', host: target.host, code: error.code });
      close();
    });
    client.on('error', close);
    upstream.on('close', close);
    client.on('close', close);
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { host, port } = parseListen(process.env.MIRROR_PROXY_LISTEN);
  const allow = (process.env.MIRROR_PROXY_ALLOW ?? DEFAULT_ALLOW.join(','))
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const server = createProxy({
    allow,
    max: Number(process.env.MIRROR_PROXY_MAX ?? 16),
    idleMs: Number(process.env.MIRROR_PROXY_IDLE_MS ?? 120_000),
    log: (entry) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`),
  });
  server.listen(port, host, () => process.stdout.write(`${JSON.stringify({ event: 'listening', host, port, allow })}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
