const rateLimit = require('express-rate-limit');
const { MemoryStore } = require('express-rate-limit');
const Redis = require('ioredis');
const logger = require('../utils/logger');
const audit = require('../services/audit');
const metrics = require('../utils/metrics');

// Redis client for rate limiting (shared instance)
let redisClient = null;

function getRedis() {
  if (redisClient) return redisClient;
  if (!process.env.REDIS_URL) return null;
  redisClient = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redisClient.on('error', () => {});
  return redisClient;
}

// Tracks, per limiter prefix, whether the store is currently degraded to the
// express-rate-limit in-memory fallback — and when it started / was last
// logged, so we warn once on the transition and periodically thereafter
// instead of on every request.
const DEGRADED_LOG_INTERVAL_MS = 5 * 60 * 1000;
const degradedState = new Map(); // prefix -> { since, lastLoggedAt, reason }

function markDegraded(prefix, reason) {
  const now = Date.now();
  const state = degradedState.get(prefix);
  metrics.rateLimiterRedisFailuresTotal.inc({ prefix, reason });

  if (!state) {
    degradedState.set(prefix, { since: now, lastLoggedAt: now, reason });
    metrics.rateLimiterDegraded.set({ prefix }, 1);
    logger.warn('Rate limiter degraded: falling back to per-process in-memory limiting', {
      prefix,
      reason,
    });
    return;
  }

  if (now - state.lastLoggedAt >= DEGRADED_LOG_INTERVAL_MS) {
    state.lastLoggedAt = now;
    logger.warn('Rate limiter still degraded: per-process in-memory limiting remains active', {
      prefix,
      reason,
      degradedForMs: now - state.since,
    });
  }
}

function markHealthy(prefix) {
  metrics.rateLimiterDegraded.set({ prefix }, 0);
  if (degradedState.has(prefix)) {
    const state = degradedState.get(prefix);
    degradedState.delete(prefix);
    logger.warn('Rate limiter recovered: shared Redis store is available again', {
      prefix,
      degradedForMs: Date.now() - state.since,
    });
  }
}

// Reports 'redis' or 'memory-fallback' per limiter prefix, for the health-check surface.
function getRateLimiterStatus() {
  return {
    auth: degradedState.has('auth') ? 'memory-fallback' : 'redis',
    payment: degradedState.has('payment') ? 'memory-fallback' : 'redis',
    read: degradedState.has('read') ? 'memory-fallback' : 'redis',
    admin: degradedState.has('admin') ? 'memory-fallback' : 'redis',
  };
}

// express-rate-limit v7 custom store backed by ioredis
class RedisStore {
  constructor(windowMs, prefix) {
    this.windowSec = Math.ceil(windowMs / 1000);
    this.prefix = prefix;
    // Per-process fallback used while Redis is unconfigured or erroring.
    // express-rate-limit has no implicit fallback: a store that returns null
    // makes every request fail with a 500.
    this.memory = new MemoryStore();
  }

  init(options) {
    this.memory.init(options);
  }

  async increment(key) {
    const redis = getRedis();
    const storeKey = `rl:${this.prefix}:${key}`;
    if (!redis) {
      // No Redis configured — fall back to in-memory (handled by express-rate-limit default)
      markDegraded(this.prefix, 'no_redis_configured');
      return this.memory.increment(key);
    }
    try {
      const multi = redis.multi();
      multi.incr(storeKey);
      multi.ttl(storeKey);
      const [[, totalHits], [, ttl]] = await multi.exec();
      if (ttl === -1) {
        await redis.expire(storeKey, this.windowSec);
      }
      const resetTime = new Date(Date.now() + (ttl > 0 ? ttl : this.windowSec) * 1000);
      markHealthy(this.prefix);
      return { totalHits, resetTime };
    } catch (err) {
      markDegraded(this.prefix, 'redis_error');
      return this.memory.increment(key); // Redis error — degrade to per-process limiting
    }
  }

  async decrement(key) {
    const redis = getRedis();
    if (!redis) return this.memory.decrement(key);
    try {
      await redis.decr(`rl:${this.prefix}:${key}`);
    } catch {}
  }

  async resetKey(key) {
    const redis = getRedis();
    if (!redis) return this.memory.resetKey(key);
    try {
      await redis.del(`rl:${this.prefix}:${key}`);
    } catch {}
  }
}

function getTrustedIp(req) {
  const trusted = (process.env.TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && trusted.length > 0) {
    const ips = forwarded.split(',').map((s) => s.trim());
    return ips[0] || req.ip;
  }
  return req.ip;
}

function makeKeyByIp(req) {
  return getTrustedIp(req);
}

function makeKeyByUser(req) {
  return req.user?.userId || getTrustedIp(req);
}

function makeKeyByAdmin(req) {
  return req.user?.userId || getTrustedIp(req);
}

function onLimitReached(req, res, options) {
  const userId = req.user?.userId || null;
  const ip = getTrustedIp(req);
  logger.warn('Rate limit exceeded', { path: req.path, ip, userId });
  audit.log(userId, 'rate_limit_exceeded', ip, req.headers['user-agent'], {
    endpoint: req.path,
    method: req.method,
  });
}

function makeHeaders(req, res, rateLimitInfo) {
  const { limit, remaining, resetTime } = rateLimitInfo;
  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));
  if (resetTime) {
    const retryAfter = Math.ceil((resetTime.getTime() - Date.now()) / 1000);
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetTime.getTime() / 1000));
    res.setHeader('Retry-After', retryAfter);
  }
}

const WINDOW_1MIN = 60 * 1000;
const WINDOW_1MIN_SEC = 60;

// Auth endpoints: 5 req/min per IP
const authLimiter = rateLimit({
  windowMs: WINDOW_1MIN,
  max: 5,
  keyGenerator: makeKeyByIp,
  store: new RedisStore(WINDOW_1MIN, 'auth'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Too many auth attempts. Please try again later.' });
  },
  message: { error: 'Too many auth attempts. Please try again later.' },
});

// Payment submission: 10 req/min per authenticated user
const paymentLimiter = rateLimit({
  windowMs: WINDOW_1MIN,
  max: 10,
  keyGenerator: makeKeyByUser,
  store: new RedisStore(WINDOW_1MIN, 'payment'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Payment rate limit exceeded. Please slow down.' });
  },
});

// Balance/read endpoints: 60 req/min per authenticated user
const readLimiter = rateLimit({
  windowMs: WINDOW_1MIN,
  max: 60,
  keyGenerator: makeKeyByUser,
  store: new RedisStore(WINDOW_1MIN, 'read'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
  },
});

// Wallet secret-key export: 3 req/15min per authenticated user — separate from the
// general read limiter because exporting a decrypted Stellar secret key is one of
// the highest-impact actions an account can take (#959).
const WINDOW_15MIN = 15 * 60 * 1000;
const exportKeyLimiter = rateLimit({
  windowMs: WINDOW_15MIN,
  max: 3,
  keyGenerator: makeKeyByUser,
  store: new RedisStore(WINDOW_15MIN, 'export-key'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Too many key export attempts. Please try again later.' });
  },
});

// Admin endpoints: 30 req/min per admin user
const adminLimiter = rateLimit({
  windowMs: WINDOW_1MIN,
  max: 30,
  keyGenerator: makeKeyByAdmin,
  store: new RedisStore(WINDOW_1MIN, 'admin'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Admin rate limit exceeded.' });
  },
});

// Attach rate limit headers on successful responses
function attachHeaders(limiter) {
  const originalMiddleware = limiter;
  return (req, res, next) => {
    const origJson = res.json.bind(res);
    res.json = (body) => {
      // headers are set by handler on 429; set on success too
      return origJson(body);
    };
    originalMiddleware(req, res, next);
  };
}

module.exports = {
  authLimiter,
  paymentLimiter,
  readLimiter,
  adminLimiter,
  exportKeyLimiter,
  RedisStore,
  getRateLimiterStatus,
};
