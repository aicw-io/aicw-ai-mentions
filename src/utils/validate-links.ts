/**
 * Link validation helpers.
 *
 * Syntax validation removes obvious non-links. Reachability validation catches
 * hallucinated domains while avoiding false negatives for sites that block bots.
 */

import { lookup } from 'node:dns/promises';
import { extractDomainFromUrl } from './url-utils.js';

const DOMAIN_VALIDATION_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
const URL_WITH_PROTOCOL_REGEX = /^(https?):\/\/.+$/;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 6;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface LinkValidationOptions {
  checkReachability?: boolean;
  timeoutMs?: number;
  concurrency?: number;
}

export interface LinkValidationResult {
  link: string;
  valid: boolean;
  reason?: string;
  statusCode?: number;
}

function normalizeCandidate(link: string): string {
  return link.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

function toFetchUrl(link: string): string | null {
  const trimmed = link.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function isValidLink(link: string): boolean {
  if (!link || typeof link !== 'string') return false;

  const cleaned = normalizeCandidate(link);
  if (cleaned.length < 4) return false;

  if (URL_WITH_PROTOCOL_REGEX.test(link.trim().toLowerCase())) {
    const domain = extractDomainFromUrl(link);
    return Boolean(domain && DOMAIN_VALIDATION_REGEX.test(domain));
  }

  const domainPart = cleaned.split('/')[0];
  return DOMAIN_VALIDATION_REGEX.test(domainPart);
}

export function filterValidLinks<T>(links: T[]): T[] {
  if (!Array.isArray(links)) return [];

  return links.filter(link => {
    if (typeof link === 'string') return isValidLink(link);
    if (Array.isArray(link) && link.length >= 1) return isValidLink(String(link[0]));
    if (link && typeof link === 'object') {
      const item = link as Record<string, unknown>;
      const candidate = typeof item.link === 'string' && item.link.trim() !== ''
        ? item.link
        : item.value;
      return typeof candidate === 'string' && isValidLink(candidate);
    }
    return false;
  });
}

async function fetchStatus(url: string, method: 'HEAD' | 'GET', timeoutMs: number): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateLinkReachability(
  link: string,
  options: LinkValidationOptions = {}
): Promise<LinkValidationResult> {
  if (!isValidLink(link)) {
    return { link, valid: false, reason: 'invalid-syntax' };
  }

  if (options.checkReachability === false) {
    return { link, valid: true };
  }

  const domain = extractDomainFromUrl(link);
  if (!domain) {
    return { link, valid: false, reason: 'missing-domain' };
  }

  try {
    await lookup(domain);
  } catch {
    return { link, valid: false, reason: 'dns-not-found' };
  }

  const url = toFetchUrl(link);
  if (!url) {
    return { link, valid: false, reason: 'invalid-url' };
  }

  try {
    let statusCode = await fetchStatus(url, 'HEAD', options.timeoutMs || DEFAULT_TIMEOUT_MS);
    if (statusCode === 405) {
      statusCode = await fetchStatus(url, 'GET', options.timeoutMs || DEFAULT_TIMEOUT_MS);
    }

    if (statusCode === 404 || statusCode === 410) {
      return { link, valid: false, reason: 'http-not-found', statusCode };
    }

    return { link, valid: true, statusCode };
  } catch (error) {
    // DNS already resolved. Keep the link when HTTP probing fails because many
    // real sites block automated HEAD/GET requests or time out intermittently.
    return {
      link,
      valid: true,
      reason: error instanceof Error ? error.message : 'http-check-failed'
    };
  }
}

export async function validateLinks(
  links: string[],
  options: LinkValidationOptions = {}
): Promise<LinkValidationResult[]> {
  const concurrency = Math.max(1, options.concurrency || DEFAULT_CONCURRENCY);
  const results: LinkValidationResult[] = new Array(links.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < links.length) {
      const current = index++;
      results[current] = await validateLinkReachability(links[current], options);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, links.length) }, () => worker())
  );

  return results;
}

