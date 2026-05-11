/**
 * Helper to format date with UTC timestamp for client-side conversion
 */
export function formatReportDate(): string {
  const now = new Date();
  const utcTimestamp = now.toISOString();
  // Return span with data attribute for JavaScript conversion
  return `<span class="report-timestamp" data-utc="${utcTimestamp}">Loading...</span>`;
}
