/**
 * URL utility functions shared across the application
 */

import { TRACKING_PARAMS } from '../config/link-tracking-params.js';


/**
 * Clean and normalize URL to canonical form for deduplication
 * Normalizes: https://example.com/page/, http://example.com/page, http://www.example.com/page/, example.com/page
 * All become: example.com/page
 */
export function cleanUrl(url: string): string {
  try {

    // decode URL to handle special characters
    url = decodeURIComponent(url);
    // Remove tracking parameters
    let cleaned = removeTrackingParams(url);

    // Remove trailing punctuation from markdown syntax or sentence endings
    // This handles cases like url), url)., url),, etc. from markdown links [text](url)
    // Includes markdown characters: * (bold/italic), [ ] (links), _ (italic)
    // These characters are very rarely intentional URL endings
    let prevLength = 0;
    while (prevLength !== cleaned.length) {
      prevLength = cleaned.length;
      cleaned = cleaned.replace(/[),.:;!?*\[\]_]$/, '');
    }

    // Remove protocol (http:// or https://)
    cleaned = cleaned.replace(/^https?:\/\//, '');

    // Remove www. prefix
    cleaned = cleaned.replace(/^www\./, '');

    // Remove trailing slashes (one or more)
    cleaned = cleaned.replace(/\/+$/, '');

    // Remove trailing punctuation AGAIN after slash removal
    // This handles cases like "url)/" → after slash removal → "url)" → "url"
    // Includes markdown characters: * (bold/italic), [ ] (links), _ (italic)
    cleaned = cleaned.replace(/[),.:;!?*\[\]_]+$/, '');

    return cleaned;
  } catch (e) {
    return url;
  }
}

export function extractDomainFromUrl(url: string): string {
  try {
    url = decodeURIComponent(url);
    const urlObj = new URL(url);
    return urlObj.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // simply string based parsing
    return url
      .toLowerCase()
      .split('?')[0]
      .split('/')[0]
      .split('#')[0]
      .split('@')[0]
      .split(':')[0]
      .split(';')[0]
      .split('=')[0]
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  }
}


/**
 * Remove tracking parameters from a URL
 * @param urlString - The URL to clean
 * @returns Cleaned URL without tracking parameters
 */
export function removeTrackingParams(urlString: string): string {
  try {
    // Handle URLs without protocol
    let workingUrl = urlString;
    let hadProtocol = true;
    if (!urlString.match(/^https?:\/\//i)) {
      workingUrl = 'http://' + urlString;
      hadProtocol = false;
    }

    const url = new URL(workingUrl);
    const params = url.searchParams;

    // Remove tracking parameters
    let paramsRemoved = false;
    for (const param of TRACKING_PARAMS) {
      if (params.has(param)) {
        params.delete(param);
        paramsRemoved = true;
      }
    }

    // If all params removed, remove the ? entirely
    if (params.toString() === '') {
      url.search = '';
    }

    // Return the cleaned URL
    let result = url.toString();

    // If the original didn't have a protocol, remove it from the result
    if (!hadProtocol) {
      result = result.replace(/^https?:\/\//, '');
    }

    return result;
  } catch (e) {
    // If URL parsing fails, return original
    return urlString;
  }
}

/**
 * Check if a title is essentially just the URL (for deduplication)
 * Used in both fetch-answers.ts (for citation formatting) and build-prompts.ts (for link extraction)
 *
 * @param url - The full URL
 * @param title - The title/text to check
 * @returns true if the title is essentially the same as the URL
 */
export function isUrlLikeTitle(url: string, title: string): boolean {
  const urlWithoutProtocol = url.replace(/^https?:\/\//, '').toLowerCase();
  const titleLower = title.toLowerCase();

  // Also check without www. prefix and trailing slashes for better matching
  const urlNoWww = urlWithoutProtocol.replace(/^www\./, '').replace(/\/$/, '');
  const titleNoWww = titleLower.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

  // Title is URL-like if it's a substring of the URL (without protocol)
  // or if normalized versions match exactly
  // or if it's marked as 'Untitled'
  return urlWithoutProtocol.includes(titleLower.replace(/^https?:\/\//, '')) ||
         urlNoWww === titleNoWww ||
         title === 'Untitled';
}