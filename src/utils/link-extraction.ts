/**
 * Shared link extraction utilities
 * Proven patterns and functions for extracting URLs from text content
 * Used by both extract-links.ts and enrich-get-source-links-for-entities.ts
 */

import { cleanUrl, extractDomainFromUrl } from './url-utils.js';

// ============================================================================
// PROVEN REGEX PATTERNS
// ============================================================================

// Proven regex patterns for link extraction - tested and working
export const REGEX_ANY_LINK = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/g;
export const REGEX_MARKDOWN_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
export const REGEX_DOMAIN_PATTERN = /\b([a-z0-9][-a-z0-9]*\.)+[a-z]{2,}\b/gi;

// ============================================================================
// MARKDOWN LINK STRIPPING
// ============================================================================

/**
 * Strip markdown link syntax, keeping only the display text.
 * - `[text](url)` → `text`
 * - `[http://example.com](url)` → `http://example.com`
 *
 * Useful for preprocessing text before entity extraction to prevent
 * the LLM from extracting entities from URLs.
 *
 * @param text - Text containing markdown links
 * @returns Text with markdown links replaced by their display text
 */
export function stripMarkdownLinks(text: string): string {
  return text.replace(REGEX_MARKDOWN_LINK, '$1');
}

// ============================================================================
// PLACEHOLDER REPLACEMENT TECHNIQUE
// ============================================================================

const DUMMY_CHAR_TO_REPLACE_SUBSTRING = '*';

/**
 * Replace a matched substring with placeholder characters
 * This prevents double-matching of the same URL by subsequent regex patterns
 */
function fillSubstringWithPlaceholder(content: string, match: RegExpExecArray): string {
  const urlStart = match.index + 1;
  let fillLength = 0;
  for (let i = 0; i < match.length; i++) {
    fillLength += match[i].length;
  }
  const urlEnd = urlStart + fillLength;
  // Generate new string with placeholder
  return content.slice(0, urlStart)
    + DUMMY_CHAR_TO_REPLACE_SUBSTRING.repeat(fillLength)
    + content.slice(urlEnd);
}

// ============================================================================
// MAIN EXTRACTION FUNCTION
// ============================================================================

/**
 * Extract links from text content using proven multi-pass approach
 *
 * This function uses a sophisticated multi-pass extraction strategy:
 * 1. Extract markdown links [text](url) first
 * 2. Replace extracted links with placeholders to prevent double-matching
 * 3. Extract plain URLs with protocol (http:// or https://)
 * 4. Replace extracted URLs with placeholders
 * 5. Finally extract plain domain mentions
 *
 * This approach ensures:
 * - No duplicate extraction of the same URL
 * - Markdown links are properly handled without interference
 * - All URL formats are captured
 *
 * @param content - Text content to extract links from
 * @returns Array of cleaned, deduplicated URLs
 */
export function extractLinksFromContent(content: string): string[] {
  const links = new Set<string>();
  const processedDomains = new Set<string>();

  // Pass 1: Extract markdown links [text](url)
  let match;
  const markdownRegex = new RegExp(REGEX_MARKDOWN_LINK);
  while ((match = markdownRegex.exec(content)) !== null) {
    const url = cleanUrl(match[2]);
    if (url && !url.startsWith('#')) { // Skip anchor links
      links.add(url);
      processedDomains.add(extractDomainFromUrl(url));
      // Replace with placeholder to prevent re-matching
      content = fillSubstringWithPlaceholder(content, match);
    }
  }

  // Pass 2: Extract plain URLs with protocol
  const urlRegex = new RegExp(REGEX_ANY_LINK);
  while ((match = urlRegex.exec(content)) !== null) {
    const url = cleanUrl(match[1]);
    if (url) {
      links.add(url);
      processedDomains.add(extractDomainFromUrl(url));
      // Replace with placeholder to prevent re-matching
      content = fillSubstringWithPlaceholder(content, match);
    }
  }

  // Pass 3: Extract plain domain mentions (which may not be full URLs)
  const domainRegex = new RegExp(REGEX_DOMAIN_PATTERN);
  while ((match = domainRegex.exec(content)) !== null) {
    const link = match[0].toLowerCase();

    // Skip if this domain was already extracted as part of a full URL
    if (!processedDomains.has(link) && !links.has(link)) {
      // Filter out common file extensions that might match the pattern
      if (!link.endsWith('.md') && !link.endsWith('.js') &&
          !link.endsWith('.ts') && !link.endsWith('.json')) {
        links.add(link);
        processedDomains.add(link);
      }
    }
  }

  // Convert to array and filter out duplicates
  const uniqueLinks = Array.from(links);

  // Filter out image links
  const filteredLinks = uniqueLinks.filter(link =>
    !link.endsWith('.jpg') &&
    !link.endsWith('.png') &&
    !link.endsWith('.gif') &&
    !link.endsWith('.jpeg') &&
    !link.endsWith('.webp') &&
    !link.endsWith('.svg')
  );

  return filteredLinks;
}
