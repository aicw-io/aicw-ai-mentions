/**
 * Report Metadata Utilities
 *
 * Adds metadata to enriched data required by the report UI:
 * - totalDates: Array of all historical dates
 * - totalDataPoints: Count of all items
 * - totalTimeSaved: Estimated time saved by automation
 * - totalCounts: Count per category
 * - itemCountPerModel: Items mentioned by each model per category
 * - itemCountPerAppearanceOrderTrend: Trend distribution
 */

// Trend indicators (must match config/trends.ts)
const TRENDS = {
  UP: 10,          // "↑" - rising trend
  DOWN: -1,        // "↓" - falling trend
  STABLE: 1,       // "→" - stable trend
  NEW: 999,        // "🆕" - new item
  DISAPPEARED: -99, // "x" - disappeared item
  FLUCTUATING: 0,  // "↔" - fluctuating trend
  UNKNOWN: -9999   // "?" - unknown/no data
};

// Main category array names
const ARRAY_NAMES = ['products', 'organizations', 'people', 'places', 'links', 'keywords', 'events'];

/**
 * Add comprehensive metadata to enriched data
 * This must be called as the LAST step before report generation
 */
export function addReportMetadata(
  data: any,
  previousDates: string[] = []
): void {
  // Add totalDates array - includes current date and all previous dates (newest first)
    data.totalDates = [data.report_date, ...previousDates]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort()
      .reverse();

  // Add totalDataPoints - count all items in all arrays
  data.totalDataPoints = Object.keys(data).reduce((total, key) => {
    if (Array.isArray(data[key])) {
      return total + data[key].length;
    }
    return total;
  }, 0);

  // Add totalTimeSaved based on data points (5 minutes per data point)
  const minutesSaved = data.totalDataPoints * 5;
  const hoursSaved = Math.ceil(minutesSaved / 60);
  data.totalTimeSaved = isNaN(hoursSaved) ? '0' : String(hoursSaved);

  // Add totalCounts object with counts for each array type
  data.totalCounts = {
    bots: data.bots ? data.bots.length : 0,
    ...ARRAY_NAMES.reduce((counts, name) => {
      counts[name] = data[name] ? data[name].length : 0;
      return counts;
    }, {} as Record<string, number>)
  };

  // Add itemCountPerModel - count of items mentioned by each bot for each array type
  data.itemCountPerModel = {};
  for (const arrayName of ARRAY_NAMES) {
    const items = data[arrayName] || [];
    const botCounts: { [botId: string]: number } = {};

    // Initialize with ALL bots from data.bots (with count=0)
    if (data.bots && Array.isArray(data.bots)) {
      for (const bot of data.bots) {
        botCounts[bot.id] = 0;
      }
    }

    // Count total mentions of items for each bot
    for (const item of items) {
      if (item.mentionsByModel) {
        for (const [botId, mentions] of Object.entries(item.mentionsByModel)) {
          if ((mentions as number) > 0) {
            botCounts[botId] = (botCounts[botId] || 0) + 1;
          }
        }
      }
    }

    // Convert to array format used by report metadata.
    data.itemCountPerModel[arrayName] = Object.entries(botCounts)
      .map(([botId, count]) => ({ id: botId, count }))
      .sort((a, b) => b.count - a.count);
  }

  // Add itemCountPerAppearanceOrderTrend - count items by their actual appearanceOrder trend values
    data.itemCountPerAppearanceOrderTrend = {};
    for (const arrayName of ARRAY_NAMES) {
      const items = data[arrayName] || [];
      const trendCounts: { [trendId: string]: number } = {};

      // Count items by their appearanceOrder trend
      for (const item of items) {
        const trend = item.appearanceOrderTrend || TRENDS.UNKNOWN;
        const trendId = String(trend);
        trendCounts[trendId] = (trendCounts[trendId] || 0) + 1;
      }

      // Convert to array format used by report metadata.
      data.itemCountPerAppearanceOrderTrend[arrayName] = Object.entries(trendCounts)
        .map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count); // Sort by count descending
    }
}
