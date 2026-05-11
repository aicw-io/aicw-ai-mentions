import OpenAI from 'openai';
import { ModelConfig, RETRY_CONFIG } from './model-config.js';
import { logger } from './compact-logger.js';
import { interruptibleDelay as delay } from './delay.js';
import { SimpleCache } from './simple-cache.js';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { USER_CACHE_DIR } from '../config/user-paths.js';
import { AICW_GITHUB_URL } from '../config/constants.js';

const DEFAULT_REQUEST_TIMEOUT_FOR_AI = 30000;

// Cache TTL configuration (seconds)
// Default: 94608000 seconds = 3 years (1095 days)
// Set AICW_AI_CACHE_TTL_SECONDS=0 to disable caching
const AI_RESPONSE_CACHE_TTL_SECONDS = parseInt(
  process.env.AICW_AI_CACHE_TTL_SECONDS || '94608000'
);

const DEFAULT_AI_RESPONSE_CACHE_NAME = 'ai-responses';
// storing ai caches here
const aiResponseCaches = new Map<string, SimpleCache>();
async function getAiResponseCache(cacheName: string): Promise<SimpleCache> {
  // return null if caching is disabled
  if (AI_RESPONSE_CACHE_TTL_SECONDS <= 0) {
    return null;
  }

  if(!cacheName || cacheName.trim() === '') {
    cacheName = DEFAULT_AI_RESPONSE_CACHE_NAME;
  }

  cacheName = `${DEFAULT_AI_RESPONSE_CACHE_NAME}-${cacheName.trim()}`;
  // check if cache already exists
  if (!aiResponseCaches.has(cacheName)) {
    const cache = new SimpleCache(cacheName, AI_RESPONSE_CACHE_TTL_SECONDS);
    aiResponseCaches.set(cacheName, cache);
    // load the cache
    await cache.load();
    logger.debug(`AI response cache for "${cacheName}" initialized (TTL: ${AI_RESPONSE_CACHE_TTL_SECONDS}s)`);
  }
  // return the cache (already initialized)
  return aiResponseCaches.get(cacheName);
}

/**
 * Debug logging for request inspection
 * Enable with: export AICW_DEBUG_CACHE_REQUESTS=true
 * Logs all requests to: USER_CACHE_DIR/debug-requests.jsonl
 */
async function debugLogRequest(modelId: string, request: any): Promise<void> {
  if (process.env.AICW_DEBUG_CACHE_REQUESTS !== 'true') {
    return;
  }

  try {
    const debugFile = path.join(USER_CACHE_DIR, 'debug-requests.jsonl');
    const logEntry = {
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      model: modelId,
      request: request
    };
    await fs.appendFile(debugFile, JSON.stringify(logEntry, null, 0) + '\n', 'utf-8');
  } catch (err) {
    // Don't fail the request due to debug logging issues
    logger.debug(`Failed to write debug log: ${err}`);
  }
}

/**
 * Normalize request for caching by removing volatile fields
 * that change between identical requests
 */
function normalizeRequestForCaching(request: any): any {
  // Clone the request to avoid modifying the original
  const normalized = { ...request };

  // List of fields that may vary between identical requests
  // and should be excluded from cache key generation.
  // These fields are typically added by the SDK or API infrastructure
  // and don't affect the semantic content of the request.
  const volatileFields = [
    'x-request-id',
    'request-id',
    'requestId',
    'trace-id',
    'traceId',
    'span-id',
    'spanId',
    'timestamp',
    'requestTimestamp'
  ];

  volatileFields.forEach(field => delete normalized[field]);

  return normalized;
}

/**
 * Stable stringify that includes all nested content with deterministic key ordering
 */
function stableStringify(obj: any): string {
  if (obj === null) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';

  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(key => JSON.stringify(key) + ':' + stableStringify(obj[key]));
  return '{' + pairs.join(',') + '}';
}

/**
 * Generate cache key from model and full request
 * Now includes ALL request parameters (model, messages, plugins, etc.)
 * not just messages, to ensure cache correctness
 */
function generateCacheKey(modelId: string, request: any): string {
  // Normalize request to remove volatile fields
  const normalized = normalizeRequestForCaching(request);

  // Use stable stringify to include all nested content
  const sortedRequest = stableStringify(normalized);
  const hash = crypto.createHash('md5').update(sortedRequest).digest('hex');

  return `${modelId}::${hash}`;
}

export function createAiClientInstance(cfg: ModelConfig, overrideApiUrl: string = null): OpenAI {
  const apiKey = process.env[cfg.api_key_env];
  
  if (!apiKey) {
    throw new Error(`Missing API key: ${cfg.api_key_env}`);
  }

  const clientInstance: OpenAI = new OpenAI({
    baseURL: overrideApiUrl || cfg.api_url,
    apiKey,
    timeout: DEFAULT_REQUEST_TIMEOUT_FOR_AI, 
    defaultHeaders: {
      'HTTP-Referer': AICW_GITHUB_URL,
      'X-Title': 'aicw-ai-mentions'
    }
  });

  return clientInstance;
}

/**
 * Options for retry behavior
 */
export interface AIApiCallRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  contextInfo?: string; // For better logging
  onStatusUpdate?: (message: string) => void; // Callback for status updates (e.g., spinner updates)
  mergeextra_body?: boolean; // Whether to merge additional request params for the model or not
  cacheNamePrefix?: string; // Prefix for the cache name (optional)
}

/**
 * Check if an error is retryable (429 rate limit or 5xx server errors)
 */
function isRetryableError(error: any): boolean {
  // Check for 5xx server errors or 429 rate limit errors
  if (error?.status) {
    return error.status === 429 || error.status >= 500;
  }

  // 404 not found is not retriable always
  if (error?.status === 404){
    return false;
  }

  // 400 bad request is not retriable always
  if (error?.status === 400){
    return false;
  }

  // Check for common network errors that might be retryable
  if (error?.code) {
    return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code);
  }  

  return false;
}

function addExtraBodyToRequestIfRequired(request: any, modelConfig: ModelConfig) {
  // we need to merge the model params with the request params
  if (modelConfig.extra_body) {
    // merging "extra_body" defined in the model config into the request params
    request = { 
      ...request, 
      extra_body: modelConfig.extra_body 
    };
    return request;
  } else {
    // return request as is
    return request;
  }
}

/**
 * Centralized function to call OpenAI API with proper retry logic
 * Handles 429 rate limits and 5xx errors with exponential backoff
 *
 * @param openai - OpenAI client instance
 * @param request - Request object for chat.completions.create
 * @param options - Optional retry configuration
 * @returns Response from OpenAI API
 */
export async function callAIWithRetry(
  openai: OpenAI,  // OpenAI instance
  modelConfig: ModelConfig,
  request: any,
  options?: AIApiCallRetryOptions
): Promise<any> {
  // Initialize cache on first use
  const aiResponseCache = await getAiResponseCache(options?.cacheNamePrefix ?? DEFAULT_AI_RESPONSE_CACHE_NAME);

  // Merge options with defaults from RETRY_CONFIG
  const config = {
    maxRetries: options?.maxRetries ?? RETRY_CONFIG.MAX_RETRIES,
    initialDelayMs: options?.initialDelayMs ?? RETRY_CONFIG.INITIAL_DELAY_MS,
    maxDelayMs: options?.maxDelayMs ?? RETRY_CONFIG.MAX_DELAY_MS,
    backoffMultiplier: options?.backoffMultiplier ?? RETRY_CONFIG.BACKOFF_MULTIPLIER,
    contextInfo: options?.contextInfo ?? 'AI API call',
    mergeextra_body: options?.mergeextra_body ?? true
  };

  let lastError: any;
  let delayMs = config.initialDelayMs;

  // check if need to merge additional request params based on the model config
  if (modelConfig && config.mergeextra_body) {
    request = addExtraBodyToRequestIfRequired(request, modelConfig);
  }

  // Debug logging: log the actual request to help identify volatile fields
  await debugLogRequest(modelConfig.model, request);

  // Check cache first
  if (aiResponseCache) {
    const cacheKey = generateCacheKey(modelConfig.model, request);
    const cached = aiResponseCache.get(cacheKey);

    if (cached) {
      logger.info(`💾 CACHE HIT for ${modelConfig.display_name} (${config.contextInfo})`);
      try {
        return JSON.parse(cached);
      } catch (err) {
        logger.warn('Failed to parse cached response, will refetch');
        aiResponseCache.delete(cacheKey);
      }
    } else {
      logger.debug(`⊗ CACHE MISS for ${modelConfig.display_name} (${config.contextInfo})`);
    }
  }

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        logger.debug(`${config.contextInfo}: Retry attempt ${attempt}/${config.maxRetries}`);
      }

      const startTime = Date.now();
      const response = await openai.chat.completions.create(request);
      const endTime = Date.now();

      // Cache the response
      if (aiResponseCache) {
        const cacheKey = generateCacheKey(modelConfig.model, request);
        try {
          aiResponseCache.set(cacheKey, JSON.stringify(response));
          // Always save immediately to ensure cache persistence (100% save rate)
          await aiResponseCache.save();
          logger.debug(`✓ Cached response for ${modelConfig.display_name}`);
        } catch (err) {
          // Don't fail the request due to caching issues
          logger.debug(`Failed to cache response: ${err}`);
        }
      }

      if (attempt > 0) {
        logger.info(`${config.contextInfo}: Succeeded after ${attempt} retries (${endTime - startTime}ms)`);
      } else {
        logger.debug(`${config.contextInfo}: Completed in ${endTime - startTime}ms`);
      }

      return response;

    } catch (error: any) {
      lastError = error;

      // Check if we should retry
      if (attempt === config.maxRetries || !isRetryableError(error)) {
        break;
      }

      // Special handling for 429 rate limit errors
      if (error?.status === 429) {
        // Check for Retry-After header
        const retryAfter = error.response?.headers?.['retry-after'];
        const rateLimitRemaining = error.response?.headers?.['x-ratelimit-remaining'];
        const rateLimitReset = error.response?.headers?.['x-ratelimit-reset'];

        // If server provides Retry-After, use it but apply exponential backoff on top
        if (retryAfter) {
          const retrySeconds = parseInt(retryAfter);
          if (!isNaN(retrySeconds)) {
            // For persistent rate limits, add exponential backoff on top of server's retry-after
            // This helps when server keeps returning the same retry-after value
            const serverSuggestedMs = retrySeconds * 1000;
            const additionalBackoff = attempt > 0 ? Math.min(attempt * 5000, 30000) : 0;
            delayMs = Math.max(delayMs, serverSuggestedMs + additionalBackoff);
            logger.info(`${config.contextInfo}: Rate limit hit (429). Server says retry after ${retrySeconds}s, waiting ${(delayMs/1000).toFixed(0)}s total`);
          }
        } else {
            // No Retry-After header - use MORE aggressive default backoff
            // Apply attempt-based multiplier to start with larger delays
            const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
            delayMs = Math.max(delayMs, Math.min(baseDelay, config.maxDelayMs));
            logger.warnImmediate(`${config.contextInfo}: Rate limit hit (429). No Retry-After header provided, using ${(delayMs/1000).toFixed(0)}s delay`);
        }

        // Log additional rate limit info if available
        if (rateLimitRemaining !== undefined) {
          logger.debug(`Rate limit remaining: ${rateLimitRemaining}`);
        }
        if (rateLimitReset !== undefined) {
          const resetDate = new Date(parseInt(rateLimitReset) * 1000);
          logger.debug(`Rate limit resets at: ${resetDate.toISOString()}`);
        }

        const waitSeconds = (delayMs / 1000).toFixed(0);
        const statusMessage = `Retry ${attempt + 1}/${config.maxRetries}, waiting ${waitSeconds}s (rate limit)`;
        logger.info(`${config.contextInfo}: Waiting ${delayMs}ms before retry ${attempt + 1}/${config.maxRetries}`);
        options?.onStatusUpdate?.(statusMessage);

      } else if (error?.status >= 500) {
        const waitSeconds = (delayMs / 1000).toFixed(0);
        const statusMessage = `Retry ${attempt + 1}/${config.maxRetries}, waiting ${waitSeconds}s (server error)`;
        logger.warnImmediate(`${config.contextInfo}: Server error (${error.status}). Retrying in ${delayMs}ms...`);
        options?.onStatusUpdate?.(statusMessage);

      } else {
        const errorCode = error?.code || 'Unknown';
        const waitSeconds = (delayMs / 1000).toFixed(0);
        const statusMessage = `Retry ${attempt + 1}/${config.maxRetries}, waiting ${waitSeconds}s (network error)`;
        logger.warnImmediate(`${config.contextInfo}: Network error (${errorCode}). Retrying in ${delayMs}ms...`);
        options?.onStatusUpdate?.(statusMessage);
      }

      // Wait before retry
      await delay(delayMs);

      // Apply exponential backoff for next attempt
      delayMs = Math.min(delayMs * config.backoffMultiplier, config.maxDelayMs);
    }
  }

  // If we get here, we've exhausted all retries
  // Save cache before failing
  if (aiResponseCache) {
    await aiResponseCache.save();
  }

  const errorMessage = `${config.contextInfo}: Failed after ${config.maxRetries + 1} attempts. Last error: ${lastError?.message || lastError}`;
  logger.error(errorMessage);

  // Preserve original error information
  const enhancedError: any = new Error(errorMessage);
  enhancedError.status = lastError?.status;
  enhancedError.originalError = lastError;
  throw enhancedError;
}

