/**
 * Central configuration for data categories used throughout the application
 *
 * Simplified structure: brands are now extracted directly with type field,
 * instead of extracting separate entity types and merging them.
 */

export const ENTITIES_CONFIG = [
  { name: "brands", isComputed: false },     // Directly extracted with type (product, organization, person, event)
  { name: "links", isComputed: false },
  { name: "linkDomains", isComputed: true },
]

/**
 * Sections that should have enrichment calculated (mentions, influence, etc.)
 * Other sections will be extracted but not enriched.
 * This simplifies output by focusing metrics on the unified brands array.
 */
export const ENRICHMENT_SECTIONS = ['brands', 'links'];

/**
 * Sections to exclude from report output.
 * These are processed internally but not shown in the simplified report.
 * Links data is kept for internal analytics but not displayed in the UI.
 */
export const REPORT_EXCLUDED_SECTIONS = ['links'];

// Main data categories that are tracked and analyzed
// MAIN_SECTIONS is basically the list of entities as stringsthat are tracked and analyzed
export const MAIN_SECTIONS = ENTITIES_CONFIG.map(entity => entity.name);

// MAIN_SECTIONS_WITH_COMPUTED_DATA is the list of entities as strings that have computed data 
// like linkDomains
export const MAIN_SECTIONS_WITH_COMPUTED_DATA = ENTITIES_CONFIG.filter(entity => entity.isComputed).map(entity => entity.name);

// All categories
export const ALL_CATEGORIES = [...MAIN_SECTIONS] as const;

// Type definitions
export type MainCategory = typeof MAIN_SECTIONS[number];
export type Category = typeof ALL_CATEGORIES[number];

// Helper functions
export function isMainCategory(category: string): category is MainCategory {
  return MAIN_SECTIONS.includes(category as MainCategory);
}

// Categories that should be included in itemsByType structures
export function getCategoriesForItemsByType(): string[] {
  // Include main categories plus 'organizations' alias for backward compatibility
  return [...MAIN_SECTIONS];
}
