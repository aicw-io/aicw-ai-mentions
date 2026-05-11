export const AGGREGATED_DIR_NAME = '_all-questions-combined';

/** Maximum number of brands to show in static report table */
export const MAX_BRANDS_IN_REPORT = 5000;

/** Maximum number of source domains to show in static report table */
export const MAX_SOURCES_IN_REPORT = 5000;
export const AICW_GITHUB_URL = 'https://github.com/aicw-io/aicw-ai-mentions';
export const CITATION_HEADER = '# CITATIONS';
export const CITATION_ITEM_FORMAT_WITH_URL = '{{INDEX}}. [{{TITLE}}]({{URL}})';

/**
 * Maximum number of previous dates to scan for missing entities or historical sources.
 * Only dates with complete answers from all models are considered.
 */
export const MAX_PREVIOUS_DATES = 10;

/**
 * When true, configs are used directly from the package instead of being copied to user data folder.
 * This skips the copying process and all config loading happens from the package directory.
 * Set via environment variable: AICW_USE_PACKAGE_CONFIG=false
 * Default: true (uses configs from package)
 */
export const USE_PACKAGE_CONFIG = true;// !(process.env.AICW_USE_PACKAGE_CONFIG === 'false');
