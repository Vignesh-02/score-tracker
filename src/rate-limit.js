import { rateLimit } from 'express-rate-limit';
import proxyaddr from 'proxy-addr';

// Counts requests on this server, so limits don't depend on Arcjet being reachable.
// The counts are in memory: they reset on restart and aren't shared between instances.

// Reverse proxies (e.g. Nginx on 127.0.0.1) whose X-Forwarded-For header can be trusted.
// Without this, every request behind Nginx looks like it comes from 127.0.0.1
// and all visitors would share one rate limit. Comma-separated, empty locally.
export const trustedProxies = (process.env.TRUSTED_PROXIES ?? '').split(',').map((ip) => ip.trim()).filter(Boolean);

const HTTP_WINDOW_MS = 10_000;
const HTTP_MAX = Number(process.env.RATE_LIMIT_MAX || 50);

const WS_WINDOW_MS = 2_000;
const WS_MAX = Number(process.env.WS_RATE_LIMIT_MAX || 5);

export const httpRateLimit = rateLimit({
    windowMs: HTTP_WINDOW_MS,
    limit: HTTP_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests.' },
});

// WebSocket upgrades never reach Express, so they're counted here instead
const wsAttempts = new Map();

// unref so this timer never keeps the process alive on its own
setInterval(() => wsAttempts.clear(), WS_WINDOW_MS).unref();

export function allowWsConnection(req) {
    const ip = proxyaddr(req, trustedProxies);
    const attempts = (wsAttempts.get(ip) ?? 0) + 1;

    wsAttempts.set(ip, attempts);

    return attempts <= WS_MAX;
}
