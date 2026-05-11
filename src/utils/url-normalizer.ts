/**
 * URL normalization utilities for dataset checks
 *
 * Provides consistent URL normalization across all indexing checks
 * (Common Crawl, Wayback Machine, Wikipedia, etc.)
 */

/**
 * Type guard to check if a string is a valid URL
 *
 * @param value - String to validate
 * @returns True if the value can be parsed as a valid URL
 *
 * @example
 * isValidUrl('https://example.com/path') // true
 * isValidUrl('example.com') // true (protocol optional)
 * isValidUrl('not a url') // false
 */
export function isValidUrl(value: string): boolean {
  if (!value || typeof value !== 'string') {
    return false;
  }

  try {
    new URL(value.startsWith('http') ? value : 'https://' + value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Type guard to check if URL is domain-only (no meaningful path)
 *
 * @param url - URL to check
 * @returns True if URL has no path or only a root path
 *
 * @example
 * isDomainOnly('https://example.com') // true
 * isDomainOnly('https://example.com/') // true
 * isDomainOnly('https://example.com/blog') // false
 */
export function isDomainOnly(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }

  try {
    const cleanUrl = url.replace(/^https?:\/\//, '');
    const urlObj = new URL('https://' + cleanUrl);
    return urlObj.pathname === '/' || urlObj.pathname === '';
  } catch {
    // Fallback: check if there's no path separator after domain
    const cleanUrl = url.replace(/^https?:\/\//, '');
    const pathStart = cleanUrl.indexOf('/');
    return pathStart === -1 || pathStart === cleanUrl.length - 1;
  }
}

/**
 * Normalize URL for dataset checking
 * - Removes protocol (https:// or http://)
 * - Removes tracking parameters (utm_*, fbclid, gclid, etc.)
 * - Removes fragment identifiers (#)
 * - Normalizes trailing slashes
 * - Keeps the full path structure
 *
 * @param url - URL to normalize
 * @returns Normalized URL suitable for dataset queries
 *
 * @example
 * normalizeUrl('https://example.com/blog/post?utm_source=twitter#section')
 * // Returns: 'example.com/blog/post'
 */
export function normalizeUrl(url: string): string {
  // Remove protocol if present
  let cleanUrl = url.replace(/^https?:\/\//, '');

  try {
    // Parse URL components (add protocol back temporarily for parsing)
    const urlObj = new URL('http://' + cleanUrl);

    // Filter out tracking parameters
    const trackingPrefixes = ['utm_', 'fbclid', 'gclid', 'mc_', '_ga', 'ref'];
    const cleanParams = new URLSearchParams();

    for (const [key, value] of urlObj.searchParams) {
      const isTrackingParam = trackingPrefixes.some(prefix => key.startsWith(prefix));
      if (!isTrackingParam) {
        cleanParams.append(key, value);
      }
    }

    // Reconstruct URL without protocol
    let normalized = urlObj.hostname + urlObj.pathname;

    // Normalize trailing slash (remove it)
    normalized = normalized.replace(/\/$/, '');

    // Add back clean query parameters if any
    const queryString = cleanParams.toString();
    if (queryString) {
      normalized += '?' + queryString;
    }

    return normalized;
  } catch (error) {
    // If URL parsing fails, just return the cleaned URL
    return cleanUrl.replace(/\/$/, '').split('#')[0];
  }
}

/**
 * Extract domain from URL (without path)
 *
 * @param url - URL to extract domain from
 * @returns Domain only (e.g., "example.com")
 * @throws Error if URL is invalid or empty
 *
 * @example
 * extractDomain('https://example.com/blog/post')
 * // Returns: 'example.com'
 */
export function extractDomain(url: string): string {
  // Validate input
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL: must be a non-empty string');
  }

  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error('Invalid URL: empty after trimming');
  }

  // Remove protocol if present
  const cleanUrl = trimmedUrl.replace(/^https?:\/\//, '');

  if (!cleanUrl) {
    throw new Error('Invalid URL: empty after protocol removal');
  }

  try {
    const urlObj = new URL('https://' + cleanUrl);
    const hostname = urlObj.hostname;

    if (!hostname) {
      throw new Error('Invalid URL: no hostname found');
    }

    return hostname;
  } catch (error) {
    // Fallback: extract domain manually
    const domain = cleanUrl.split('/')[0].split('?')[0].split('#')[0];

    if (!domain) {
      throw new Error(`Failed to extract domain from URL: ${url}`);
    }

    // Basic validation: domain should have at least one dot (unless localhost)
    if (!domain.includes('.') && domain !== 'localhost') {
      throw new Error(`Invalid domain format: ${domain}`);
    }

    return domain;
  }
}

/**
 * Safely extract domain from URL without throwing
 * Returns null if extraction fails
 *
 * @param url - URL to extract domain from
 * @returns Domain string or null if extraction fails
 *
 * @example
 * extractDomainSafe('https://example.com/path') // 'example.com'
 * extractDomainSafe('invalid') // null
 */
export function extractDomainSafe(url: string): string | null {
  try {
    return extractDomain(url);
  } catch {
    return null;
  }
}

/**
 * Normalize URL with protocol for external API calls
 * Ensures URL has https:// prefix
 *
 * @param url - URL to normalize
 * @returns URL with https:// prefix
 */
export function normalizeUrlWithProtocol(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  return 'https://' + url;
}
