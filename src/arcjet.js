import arcjet, {detectBot, shield, slidingWindow} from "@arcjet/node";

const arcjetKey = process.env.ARCJET_KEY;
const arcjetMode = process.env.ARCJET_MODE === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE';

// Reverse proxies (e.g. Nginx on 127.0.0.1) whose X-Forwarded-For header can be trusted.
// Without this, every request behind Nginx looks like it comes from 127.0.0.1
// and all visitors would share one rate limit. Comma-separated, empty locally.
const trustedProxies = (process.env.TRUSTED_PROXIES ?? '').split(',').map((ip) => ip.trim()).filter(Boolean);

if(!arcjetKey) console.warn('ARCJET_KEY is missing. Arcjet protection is disabled.');

export const httpArcjet = arcjetKey ?
    arcjet({
        key: arcjetKey,
        proxies: trustedProxies,
        rules: [
            shield({ mode: arcjetMode }),
            // detectBot({ mode: arcjetMode, allow: ['CATEGORY:SEARCH_ENGINE', "CATEGORY:PREVIEW" ]}),
            slidingWindow({ mode: arcjetMode, interval: '10s', max: 50 })
        ],
    }) : null;

export const wsArcjet = arcjetKey ?
    arcjet({
        key: arcjetKey,
        proxies: trustedProxies,
        rules: [
            shield({ mode: arcjetMode }),
            // detectBot needs a User-Agent header, which many WebSocket clients
            // (wscat, Node scripts) don't send, so it errored on every such connection
            // detectBot({ mode: arcjetMode, allow: ['CATEGORY:SEARCH_ENGINE', "CATEGORY:PREVIEW" ]}),
            slidingWindow({ mode: arcjetMode, interval: '2s', max: 5 })
        ],
    }) : null;

export function securityMiddleware() {
    return async (req, res, next) => {
        if(!httpArcjet) return next();

        try {
            const decision = await httpArcjet.protect(req);

            // Arcjet fails open: on errors protect() doesn't throw, it allows the request
            if(decision.isErrored()) {
                console.warn('Arcjet error, allowing request:', decision.reason.message);
            }

            if(decision.isDenied()) {
                if(decision.reason.isRateLimit()) {
                    return res.status(429).json({ error: 'Too many requests.' });
                }

                return res.status(403).json({ error: 'Forbidden.' });
            }
        } catch (e) {
            console.error('Arcjet middleware error', e);
            return res.status(503).json({ error: 'Service Unavailable' });
        }

        next();
    }
}