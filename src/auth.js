import { timingSafeEqual } from 'node:crypto';

const adminKey = process.env.ADMIN_API_KEY;

if(!adminKey) console.warn('ADMIN_API_KEY is missing. Write routes are disabled.');

// Protects routes that change data. Clients must send the key in the
// `x-api-key` header. Read-only routes stay public.
export function requireAdmin(req, res, next) {
    // Fail closed: without a configured key, nobody can write
    if(!adminKey) {
        return res.status(503).json({ error: 'Write routes are disabled' });
    }

    const provided = Buffer.from(req.get('x-api-key') ?? '');
    const expected = Buffer.from(adminKey);

    // timingSafeEqual takes the same time however many characters match,
    // so the key can't be guessed character by character from response times
    if(provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
}
