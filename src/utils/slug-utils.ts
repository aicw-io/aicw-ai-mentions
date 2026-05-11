/**
 * URL slug generation utilities for entity pages
 */

/**
 * Convert entity value to URL-safe slug
 * Examples:
 *   "Docker" → "docker"
 *   "GitHub Actions" → "github-actions"
 *   "some-example.com" → "some-example-com"
 *   "Company Name (Inc.)" → "company-name-inc"
 */
export function slugify(value: string): string {
    return value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with dash
        .replace(/^-+|-+$/g, '');      // Trim leading/trailing dashes
}

/**
 * Generate entity page filename
 */
export function getEntityPageFilename(value: string): string {
    return `${slugify(value)}.html`;
}

/**
 * Generate entity page URL (relative to index.html)
 */
export function getEntityPageUrl(value: string): string {
    return `mention/${slugify(value)}.html`;
}
