/**
 * Entity page generation utilities
 * Generates individual HTML pages for each brand entity
 */

import { promises as fs } from 'fs';
import path from 'path';
import { slugify } from './slug-utils.js';
import { replaceMacrosInTemplate, writeFileAtomic, loadCustomFooterCode } from './misc-utils.js';
import { logger } from './compact-logger.js';
import { loadDataJs, readQuestions } from './project-utils.js';
import { getCurrentVersion } from './update-checker.js';

/**
 * Format a decimal value as a percentage string
 */
function formatPercent(value: number | undefined | null): string {
  if (value === undefined || value === null) return 'N/A';
  const percent = value * 100;
  const formatted = parseFloat(percent.toFixed(1)).toString();
  return `${formatted}%`;
}

/**
 * Format ISO date to human-readable format like "Dec 13, 2025"
 */
function formatDateHuman(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  } catch {
    return isoDate;
  }
}

/**
 * Count how many bots mentioned this entity
 */
function countBots(entity: Record<string, unknown>): number {
  if (entity.bots && typeof entity.bots === 'string') {
    return (entity.bots as string).split(',').filter((b: string) => b.trim()).length;
  }
  if (entity.mentionsByModel && typeof entity.mentionsByModel === 'object') {
    return Object.keys(entity.mentionsByModel as Record<string, number>).filter(
      k => (entity.mentionsByModel as Record<string, number>)[k] > 0
    ).length;
  }
  return 0;
}

/**
 * Format large numbers with suffix (M for millions, B for billions)
 */
function formatMAU(value: number | undefined): string {
  if (!value || value === 0) return 'N/A';
  if (value >= 1000000000) {
    return `${(value / 1000000000).toFixed(1).replace(/\.0$/, '')}B`;
  }
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(0)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(0)}K`;
  }
  return value.toString();
}

/**
 * Build compact summary of model weights for FAQ (e.g., "ChatGPT: 900M MAU, Claude: 30M MAU")
 */
function buildModelWeightsSummary(bots: Array<{ id: string; name: string; estimated_mau?: number }>): string {
  const botsWithMAU = bots
    .filter(b => b.estimated_mau && b.estimated_mau > 0)
    .sort((a, b) => (b.estimated_mau || 0) - (a.estimated_mau || 0))
    .slice(0, 3); // Show top 3 for brevity

  if (botsWithMAU.length === 0) return '';

  return botsWithMAU.map(b => `${b.name}: ${formatMAU(b.estimated_mau)} MAU`).join(', ') +
    (bots.length > 3 ? ', etc.' : '');
}

/**
 * Returns HTML for trend indicator (↑ rising, ↓ falling, → stable, ★ new)
 */
function getTrendIcon(trend: number | undefined): string {
  if (trend === undefined || trend === -9999 || trend === 999) return '';
  if (trend >= 10) return '<span class="text-green-500 ml-1" title="Rising fast">↑↑</span>';
  if (trend >= 1) return '<span class="text-green-500 ml-1" title="Rising">↑</span>';
  if (trend <= -10) return '<span class="text-red-500 ml-1" title="Falling fast">↓↓</span>';
  if (trend <= -1) return '<span class="text-red-500 ml-1" title="Falling">↓</span>';
  return '';
}

/**
 * Get names of bots that mention this entity
 */
function getMentioningBotNames(entity: Record<string, unknown>, bots: Array<{ id: string; name: string }>): string[] {
  const mentionsByModel = entity.mentionsByModel as Record<string, number> || {};
  const entityBots = entity.bots ? (entity.bots as string).split(',').map(b => b.trim()) : [];
  return bots
    .filter(bot => entityBots.includes(bot.id) || (mentionsByModel[bot.id] && mentionsByModel[bot.id] > 0))
    .map(bot => bot.name);
}

/**
 * Map entity type(s) to Schema.org type(s)
 * Supports comma-separated types like "organization,product"
 */
function getSchemaType(entityType: string | undefined): string | string[] {
  // Using Brand instead of Product/SoftwareApplication to avoid Google requiring
  // offers/review/aggregateRating fields (which we don't have for mention reports)
  const mapping: Record<string, string> = {
    'organization': 'Organization',
    'product': 'Brand',
    'person': 'Person',
    'event': 'Brand',
    'brand': 'Brand',
    'software': 'Brand',
    'service': 'Service'
  };

  if (!entityType) return 'Thing';

  // Handle comma-separated multiple types
  const types = entityType.split(',').map(t => t.trim().toLowerCase());
  const schemaTypes = types
    .map(t => mapping[t])
    .filter(Boolean);

  // Return single string for single type, array for multiple types
  if (schemaTypes.length === 0) return 'Thing';
  if (schemaTypes.length === 1) return schemaTypes[0];
  return schemaTypes;
}

/**
 * Build JSON-LD structured data for an entity page
 * Enhanced with FAQPage schema for SEO
 */
function buildJsonLd(
  entity: Record<string, unknown>,
  meta: {
    canonicalUrl: string;
    projectName: string;
    reportDate: string;
    entityType: string;
    botNames: string;
    questionsList: string;
    questionCount: number;
    formattedDate: string;
    baseUrl?: string;  // Base URL for absolute URLs (e.g., https://aicw.io/ranking/Project/questionId/)
  },
  totalEntities: number,
  faqs?: Array<{ question: string; answer: string }>
): string {
  const schemaType = getSchemaType(entity.type as string);
  const entityName = (entity.value || entity.code || '') as string;
  const rank = entity.rank as number || 0;
  const mentions = entity.mentions as number || 0;
  const influence = formatPercent(entity.influence as number);
  const link = entity.link as string | undefined;

  // Build rich description for entity (plain text, no HTML)
  const richDescription = `${entityName} (${meta.entityType}) was ranked #${rank} out of ${totalEntities} in the list of brands (${mentions} mentions, ${influence} share) in answers from AI models (${meta.botNames}) when asked the following ${meta.questionCount} question${meta.questionCount !== 1 ? 's' : ''}: ${meta.questionsList} on ${meta.formattedDate}.`;

  // Build URL with https:// prefix if needed
  const entityUrl = link ? (link.startsWith('http') ? link : `https://${link}`) : undefined;

  // Build absolute URLs for JSON-LD (Google requires absolute URLs for @id fields)
  const absoluteCanonicalUrl = meta.baseUrl ? `${meta.baseUrl}${meta.canonicalUrl}` : meta.canonicalUrl;
  const absoluteIndexUrl = meta.baseUrl ? `${meta.baseUrl}index.html` : '../index.html';

  const graph: object[] = [
    {
      "@type": "WebPage",
      "@id": `${absoluteCanonicalUrl}#webpage`,
      "url": absoluteCanonicalUrl,
      "name": `${entityName} - AI Mentions Report`,
      "description": `${entityName} mentioned ${mentions} times by AI models. Rank #${rank} of ${totalEntities} with ${influence} share of voice.`,
      "datePublished": meta.reportDate,
      "isPartOf": {
        "@type": "WebSite",
        "name": "AICW AI Mentions",
        "url": "https://aicw.io"
      },
      "mainEntity": { "@id": `${absoluteCanonicalUrl}#entity` }
    },
    {
      "@type": schemaType,
      "@id": `${absoluteCanonicalUrl}#entity`,
      "name": entityName,
      "description": richDescription,
      ...(entityUrl ? { "url": entityUrl, "sameAs": entityUrl } : {})
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": meta.projectName, "item": absoluteIndexUrl },
        { "@type": "ListItem", "position": 2, "name": "Mentions", "item": `${absoluteIndexUrl}#mentions` },
        { "@type": "ListItem", "position": 3, "name": entityName, "item": absoluteCanonicalUrl }
      ]
    }
  ];

  // Add FAQPage schema if FAQs provided
  if (faqs && faqs.length > 0) {
    graph.push(buildEntityFaqJsonLd(faqs));
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": graph
  };

  return JSON.stringify(jsonLd, null, 2);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate static HTML for metrics cards (for noscript/SEO)
 * Order matches main report table columns: Rank, Voice, Position, Mentions, AI
 */
function generateMetricsCardsHtml(entity: Record<string, unknown>, entityRank: number): string {
  const mentions = entity.mentions as number || 0;
  const mentionsAsPercent = formatPercent(entity.mentionsAsPercent as number);
  const influence = formatPercent(entity.influence as number);
  const position = entity.appearanceOrder !== undefined
    ? `${Math.round(entity.appearanceOrder as number)}`
    : 'N/A';
  const bots = countBots(entity);

  // Get trend indicators
  const influenceTrend = getTrendIcon(entity.influenceTrend as number | undefined);
  const positionTrend = getTrendIcon(entity.appearanceOrderTrend as number | undefined);
  const mentionsTrend = getTrendIcon(entity.mentionsTrend as number | undefined);

  return `
    <div class="metric-card-sm">
        <div class="metric-value-sm">#${entityRank}</div>
        <div class="metric-label-sm">Rank</div>
    </div>
    <div class="metric-card-sm">
        <div class="metric-value-sm">${influence}${influenceTrend}</div>
        <div class="metric-label-sm">Voice</div>
    </div>
    <div class="metric-card-sm">
        <div class="metric-value-sm">${position}${positionTrend}</div>
        <div class="metric-label-sm">Position</div>
    </div>
    <div class="metric-card-sm">
        <div class="metric-value-sm">${mentions} (${mentionsAsPercent})${mentionsTrend}</div>
        <div class="metric-label-sm">Mentions</div>
    </div>`;
}

/**
 * Get bot icon class based on bot ID
 */
function getBotIconClass(botId: string): string {
  const knownBots = ['google_gemini', 'perplexity_ai', 'brave_search', 'you_com', 'openai_searchgpt'];
  return knownBots.includes(botId) ? `icon_bot_${botId}` : 'icon_bot_unknown';
}

/**
 * Generate static HTML for model table rows (for noscript/SEO)
 */
function generateModelTableRowsHtml(entity: Record<string, unknown>, bots: Array<{ id: string; name: string }>): string {
  const mentionsByModel = entity.mentionsByModel as Record<string, number> || {};
  const influenceByModel = entity.influenceByModel as Record<string, number> || {};
  const appearanceOrderByModel = entity.appearanceOrderByModel as Record<string, number> || {};
  const entityBots = entity.bots ? (entity.bots as string).split(',').map(b => b.trim()) : [];

  // Get bots with data for this entity
  const botsWithData = bots.filter(bot => {
    if (entityBots.includes(bot.id)) return true;
    if (mentionsByModel[bot.id] && mentionsByModel[bot.id] > 0) return true;
    return false;
  });

  if (botsWithData.length === 0) {
    return '<tr><td colspan="4" class="text-center">No model data available</td></tr>';
  }

  // Sort by influence (descending - largest first)
  const sortedBots = [...botsWithData].sort((a, b) => {
    const influenceA = influenceByModel[a.id] || 0;
    const influenceB = influenceByModel[b.id] || 0;
    return influenceB - influenceA;
  });

  return sortedBots.map(bot => {
    const mentions = mentionsByModel[bot.id] || 0;
    const influence = influenceByModel[bot.id] !== undefined ? formatPercent(influenceByModel[bot.id]) : 'N/A';
    const position = appearanceOrderByModel[bot.id] !== undefined ? `${Math.round(appearanceOrderByModel[bot.id])}` : 'N/A';
    const iconClass = getBotIconClass(bot.id);
    const initial = bot.name.charAt(0);

    return `
            <tr>
                <td class="flex items-center gap-2">
                    <span class="icon_bot ${iconClass}" title="${escapeHtml(bot.name)}">${initial}</span>
                    ${escapeHtml(bot.name)}
                </td>
                <td class="text-center">${influence}</td>
                <td class="text-center">${position}</td>
                <td class="text-center">${mentions}</td>
            </tr>`;
  }).join('');
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return null;
  }
}

/**
 * Generate static hero section HTML (for noscript/SEO)
 */
function generateHeroHtml(entity: Record<string, unknown>, entityRank: number): string {
  const entityName = escapeHtml((entity.value || entity.code || '') as string);
  const entityType = escapeHtml((entity.type || 'brand') as string);
  const influence = formatPercent(entity.influence as number);
  const botCount = countBots(entity);
  const link = entity.link as string | undefined;
  const domain = extractDomain(link);

  let logoHtml = '';
  if (domain) {
    logoHtml = `
                        <div class="flex-shrink-0 w-16 h-16 md:w-20 md:h-20 bg-white rounded-xl p-2 shadow-lg">
                            <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=128"
                                 class="w-full h-full object-contain"
                                 alt="${entityName}"
                                 onerror="this.parentElement.style.display='none';" />
                        </div>`;
  }

  let linkHtml = '';
  if (link && domain) {
    linkHtml = `
                            <a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"
                               class="text-white/80 hover:text-white flex items-center gap-2 mt-2 text-sm md:text-base" style="color: rgba(255,255,255,0.8) !important;">
                                <i class="fas fa-external-link-alt"></i>
                                ${escapeHtml(domain)}
                            </a>`;
  } else {
    linkHtml = `
                            <p class="text-white/60 text-sm mt-2">
                                Mentioned by ${botCount} AI model${botCount !== 1 ? 's' : ''}
                            </p>`;
  }

  return `
            <div class="bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-500 rounded-2xl shadow-2xl p-6 md:p-8 text-white">
                <div class="flex flex-col md:flex-row items-start md:items-center gap-6">
                    <!-- Large Rank Badge -->
                    <div class="flex-shrink-0 w-20 h-20 md:w-28 md:h-28 bg-white/20 backdrop-blur rounded-2xl flex items-center justify-center border-4 border-white/30">
                        <span class="text-4xl md:text-5xl font-black">#${entityRank}</span>
                    </div>

                    <!-- Brand Logo + Info -->
                    <div class="flex flex-col md:flex-row items-start md:items-center gap-4 md:gap-6 flex-1">
                        <!-- Large Favicon/Logo -->${logoHtml}

                        <!-- Brand Name & Type -->
                        <div class="flex-1">
                            <span class="inline-block px-3 py-1 rounded-full text-xs font-semibold bg-white/20 mb-2 capitalize">
                                ${entityType}
                            </span>
                            <h1 class="text-3xl md:text-4xl font-black">${entityName}</h1>${linkHtml}
                        </div>
                    </div>

                    <!-- Quick Stats (Right Side) -->
                    <div class="flex-shrink-0 text-left md:text-right mt-4 md:mt-0">
                        <div class="text-3xl md:text-4xl font-black">${influence}</div>
                        <div class="text-sm opacity-80">Share of Voice</div>
                    </div>
                </div>
            </div>`;
}

/**
 * Generate static HTML for questions section
 * NOTE: Questions are now shown in the About section, so this returns empty
 * Keeping function for backward compatibility with template placeholders
 */
function generateQuestionsHtml(
  entity: Record<string, unknown>,
  questionsByPrompt: Record<string, string>
): { indicator: string; modal: string; questions: Array<{ id: string; text: string }> } {
  // Collect unique questions from excerpts (still needed for About section)
  const excerptsByModel = entity.excerptsByModel as Record<string, Array<{ promptId?: string }>> || {};
  const uniqueQuestions = new Map<string, string>();

  for (const excerpts of Object.values(excerptsByModel)) {
    for (const excerpt of excerpts || []) {
      if (excerpt.promptId && questionsByPrompt[excerpt.promptId] && !uniqueQuestions.has(excerpt.promptId)) {
        uniqueQuestions.set(excerpt.promptId, questionsByPrompt[excerpt.promptId]);
      }
    }
  }

  const questionsArray = Array.from(uniqueQuestions.entries()).map(([id, text]) => ({ id, text }));

  // Return empty strings for badge/modal (now shown in About section instead)
  return { indicator: '', modal: '', questions: questionsArray };
}

/**
 * Generate static HTML for source links table
 */
function generateSourceLinksHtml(
  entity: Record<string, unknown>,
  bots: Array<{ id: string; name: string; url?: string }>
): string {
  const sources = entity.sources as Array<{ url: string; bots?: string }> | undefined;
  if (!sources || sources.length === 0) return '';

  // Helper to get bot favicon URL
  const getModelIconUrl = (botId: string): string => {
    const bot = bots.find(b => b.id === botId);
    const url = bot?.url || '';
    if (url) {
      const domain = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    }
    return '';
  };

  // Helper to create website page URL
  const getWebsitePageUrl = (sourceUrl: string): string => {
    const domain = sourceUrl.split('/')[0];
    const slug = domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `../website/${slug}.html`;
  };

  let html = `
        <div class="container mx-auto px-4 py-4">
            <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                <h2 class="text-xl font-bold mb-4 text-gray-900 dark:text-white">
                    <i class="fas fa-link mr-2"></i>
                    Source Links
                </h2>
                <div class="overflow-x-auto">
                    <table class="w-full">
                        <thead>
                            <tr>
                                <th>URL</th>
                                <th>Mentioned By</th>
                            </tr>
                        </thead>
                        <tbody>`;

  for (const source of sources) {
    const domain = source.url.split('/')[0];
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    const pageUrl = getWebsitePageUrl(source.url);
    const botIds = source.bots ? source.bots.split(',').map(b => b.trim()).filter(Boolean) : [];

    html += `
                            <tr>
                                <td>
                                    <div class="flex items-center gap-2">
                                        <img src="${faviconUrl}"
                                             class="w-5 h-5 rounded flex-shrink-0"
                                             alt="${escapeHtml(domain)}"
                                             onerror="this.style.display='none'">
                                        <a href="${escapeHtml(pageUrl)}"
                                           class="text-blue-600 hover:underline break-all">
                                            ${escapeHtml(source.url)}
                                        </a>
                                    </div>
                                </td>
                                <td>
                                    <div class="flex items-center gap-1 flex-wrap">`;

    for (const botId of botIds) {
      const bot = bots.find(b => b.id === botId);
      const botName = bot?.name || botId;
      const iconUrl = getModelIconUrl(botId);
      const iconClass = getBotIconClass(botId);

      if (iconUrl) {
        html += `
                                        <img src="${iconUrl}"
                                             alt="${escapeHtml(botName)}"
                                             title="${escapeHtml(botName)}"
                                             class="w-5 h-5 rounded">`;
      } else {
        html += `
                                        <span class="icon_bot ${iconClass}" title="${escapeHtml(botName)}">
                                            ${botName.charAt(0)}
                                        </span>`;
      }
    }

    html += `
                                    </div>
                                </td>
                            </tr>`;
  }

  html += `
                        </tbody>
                    </table>
                </div>
            </div>
        </div>`;

  return html;
}

/**
 * Generate static HTML for tabbed excerpts section
 * First model with content is visible, others hidden until static tab controls switch sections.
 */
function generateExcerptsHtml(
  entity: Record<string, unknown>,
  bots: Array<{ id: string; name: string; url?: string }>,
  questionsByPrompt: Record<string, string>
): string {
  const excerptsByModel = entity.excerptsByModel as Record<string, Array<{
    promptId?: string;
    excerpt?: string;
    text?: string;
    captureDate?: string;
    question?: string;
    appearanceOrder?: number;
  }>> || {};

  // Get bots that have data for this entity
  const entityBots = entity.bots ? (entity.bots as string).split(',').map(b => b.trim()) : [];
  const mentionsByModel = entity.mentionsByModel as Record<string, number> || {};

  const botsWithData = bots.filter(bot => {
    if (entityBots.includes(bot.id)) return true;
    if (mentionsByModel[bot.id] && mentionsByModel[bot.id] > 0) return true;
    return false;
  });

  if (botsWithData.length === 0) return '';

  // Find first model with excerpts
  const firstModelWithContent = botsWithData.find(bot => {
    const excerpts = excerptsByModel[bot.id];
    return excerpts && excerpts.length > 0;
  });

  if (!firstModelWithContent) return '';

  // Helper to get bot favicon URL
  const getModelIconUrl = (botId: string): string => {
    const bot = bots.find(b => b.id === botId);
    const url = bot?.url || '';
    if (url) {
      const domain = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
    }
    return '';
  };

  // Helper to highlight entity name in text
  const highlightEntity = (text: string): string => {
    const entityName = (entity.value || entity.code || '') as string;
    if (!entityName || !text) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const regex = new RegExp(`(${entityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(regex, '<mark class="brand-highlight">$1</mark>');
  };

  let html = `
        <div class="container mx-auto px-4 py-4 mb-8">
            <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                <h2 class="text-xl font-bold mb-4 text-gray-900 dark:text-white">
                    <i class="fas fa-quote-left mr-2"></i>
                    Citations from AI Responses
                </h2>

                <!-- Tab Bar -->
                <div class="flex gap-1 overflow-x-auto pb-2 mb-4 border-b border-gray-200 dark:border-gray-700">`;

  // Generate tab buttons
  for (const bot of botsWithData) {
    const excerpts = excerptsByModel[bot.id] || [];
    const count = excerpts.length;
    const isActive = bot.id === firstModelWithContent.id;
    const iconUrl = getModelIconUrl(bot.id);
    const iconClass = getBotIconClass(bot.id);

    const activeClass = isActive
      ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border-b-2 border-indigo-500'
      : count > 0
        ? 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
        : 'text-gray-400 dark:text-gray-600';

    html += `
                    <button class="excerpt-tab flex items-center gap-2 px-3 py-2 rounded-t-lg text-sm font-medium whitespace-nowrap transition-colors ${activeClass}"
                            data-tab-id="${bot.id}"
                            onclick="window.entityApp && window.entityApp.selectExcerptTab('${bot.id}')">`;

    if (iconUrl) {
      html += `
                        <img src="${iconUrl}" alt="${escapeHtml(bot.name)}" class="w-5 h-5 rounded">`;
    } else {
      html += `
                        <span class="icon_bot ${iconClass}">${bot.name.charAt(0)}</span>`;
    }

    html += `
                        <span class="hidden sm:inline">${escapeHtml(bot.name)}</span>
                        <span class="text-xs ${count > 0 ? 'text-gray-500' : 'text-gray-400'}">(${count})</span>
                    </button>`;
  }

  html += `
                </div>

                <!-- Tab Content -->`;

  // Generate tab content for each bot
  for (const bot of botsWithData) {
    const excerpts = excerptsByModel[bot.id] || [];
    const isActive = bot.id === firstModelWithContent.id;
    const displayStyle = isActive ? '' : ' style="display: none;"';

    html += `
                <div class="excerpt-tab-content" data-tab-content="${bot.id}"${displayStyle}>`;

    if (excerpts.length === 0) {
      html += `
                    <div class="text-center py-8 text-gray-500 dark:text-gray-400">
                        <i class="fas fa-comment-slash text-3xl mb-2"></i>
                        <p>No citations from ${escapeHtml(bot.name)}</p>
                    </div>`;
    } else {
      // Group excerpts by promptId
      const groupedExcerpts: Record<string, typeof excerpts> = {};
      for (const excerpt of excerpts) {
        const key = excerpt.promptId || 'unknown';
        if (!groupedExcerpts[key]) groupedExcerpts[key] = [];
        groupedExcerpts[key].push(excerpt);
      }

      for (const [promptId, promptExcerpts] of Object.entries(groupedExcerpts)) {
        const questionText = promptExcerpts[0]?.question || questionsByPrompt[promptId] || null;

        if (questionText) {
          html += `
                    <p class="text-sm text-gray-500 dark:text-gray-400 mb-2 flex items-center">
                        <i class="fas fa-question-circle mr-2"></i>
                        <span class="italic">${escapeHtml(questionText)}</span>
                    </p>`;
        }

        for (const excerpt of promptExcerpts) {
          const text = excerpt.excerpt || excerpt.text || '';

          // Add truncation indicators (same as website pages)
          const CONTEXT_CHARS = 300;
          let displayText = highlightEntity(text);
          // Add prefix if excerpt starts mid-answer (character position > context chars)
          if ((excerpt.appearanceOrder || 0) > CONTEXT_CHARS) {
            displayText = '[...] ' + displayText;
          }
          // Add suffix to indicate more content follows
          displayText = displayText + ' [...]';

          html += `
                    <div class="citation-block mb-4">
                        <p class="citation-text">${displayText}</p>
                        <p class="citation-meta">`;

          let formattedDate = '';
          if (excerpt.captureDate) {
            const date = new Date(excerpt.captureDate);
            formattedDate = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            html += `
                            <i class="fas fa-calendar mr-1"></i> ${formattedDate}`;
          }

          html += `
                        </p>`;

          // Add "View Full Answer" button
          const safeQuestion = escapeHtml(questionText || 'Unknown Question').replace(/'/g, "\\'").replace(/"/g, '&quot;');
          const safeBotName = escapeHtml(bot.name).replace(/'/g, "\\'");
          const safePromptId = escapeHtml(promptId).replace(/'/g, "\\'");
          const safeBotId = escapeHtml(bot.id).replace(/'/g, "\\'");
          const iconUrl = getModelIconUrl(bot.id) || '';
          const safeIconUrl = escapeHtml(iconUrl).replace(/'/g, "\\'");
          const botIconClass = getBotIconClass(bot.id);
          const botInitial = bot.name.charAt(0);

          html += `
                        <button class="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 mt-2 flex items-center gap-1"
                                onclick="openAnswerModal('${safeQuestion}', '${safeBotName}', '${safeIconUrl}', '${botIconClass}', '${botInitial}', '${formattedDate || 'N/A'}', window.getFullAnswerText('${safePromptId}', '${safeBotId}'))">
                            <i class="fas fa-expand"></i> View Full Answer
                        </button>
                    </div>`;
        }
      }
    }

    html += `
                </div>`;
  }

  html += `
            </div>
        </div>`;

  return html;
}

/**
 * Helper to get model icon URL from bot's URL
 */
function getModelIconUrlFromBot(bot: { id: string; name: string; url?: string }): string {
  const url = bot.url || '';
  if (url) {
    const domain = url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  }
  return '';
}

/**
 * Generate introduction/about section HTML for entity page SEO
 * Uses natural language format with inline AI icons
 */
function generateEntityIntroHtml(
  entity: Record<string, unknown>,
  entityRank: number,
  totalEntities: number,
  bots: Array<{ id: string; name: string; url?: string }>,
  config: {
    reportDate: string;
    questions?: Array<{ id: string; text: string }>;
    basePath?: string;
  }
): string {
  const { reportDate, questions = [], basePath = '../' } = config;
  const entityName = escapeHtml((entity.value || entity.code || '') as string);
  const entityType = (entity.type || 'brand') as string;
  const mentions = entity.mentions as number || 0;
  const influence = formatPercent(entity.influence as number);
  const formattedDate = formatDateHuman(reportDate);

  // Get entity's mentioning bots
  const mentionsByModel = entity.mentionsByModel as Record<string, number> || {};
  const entityBots = entity.bots ? (entity.bots as string).split(',').map(b => b.trim()) : [];
  const mentioningBots = bots.filter(bot => {
    if (entityBots.includes(bot.id)) return true;
    if (mentionsByModel[bot.id] && mentionsByModel[bot.id] > 0) return true;
    return false;
  });

  // Build AI models list with inline icons
  let aiModelsText = 'various AI models';
  if (mentioningBots.length > 0) {
    aiModelsText = mentioningBots.slice(0, 5).map(bot => {
      const iconUrl = getModelIconUrlFromBot(bot);
      const icon = iconUrl
        ? `<img src="${iconUrl}" alt="" class="w-4 h-4 inline-block align-middle rounded mr-0.5" onerror="this.style.display='none'">`
        : '';
      return `${icon}${escapeHtml(bot.name)}`;
    }).join(', ');
    if (mentioningBots.length > 5) {
      aiModelsText += ` +${mentioningBots.length - 5} more`;
    }
  }

  // Build questions list inline (italicized)
  let questionsText = '';
  if (questions.length > 0) {
    questionsText = questions.map(q => `<i>"${escapeHtml(q.text)}"</i>`).join(', ');
  }

  // Build the natural language paragraph
  let introText = `This page provides details about <strong>${entityName}</strong> (${escapeHtml(entityType)}) which was ranked <strong>#${entityRank}</strong> out of ${totalEntities} in the list of brands `;
  introText += `(${mentions} mention${mentions !== 1 ? 's' : ''} (${influence} share)) `;
  introText += `in answers from AI models (${aiModelsText})`;

  if (questionsText) {
    introText += ` when they were asked the following ${questions.length} question${questions.length !== 1 ? 's' : ''}: ${questionsText}`;
  }

  introText += ` on <strong>${formattedDate}</strong> by <a href="https://www.aicw.io/aicw-ai-mentions" class="text-indigo-600 hover:underline">AICW AI Mentions</a>.`;

  return `
        <section class="entity-intro bg-white dark:bg-gray-800 rounded-lg shadow p-5 mb-4">
            <h2 class="text-lg font-bold mb-3 text-gray-900 dark:text-white">
                <i class="fas fa-info-circle mr-2 text-indigo-500"></i>About ${entityName} (${escapeHtml(entityType)})
            </h2>
            <p class="text-gray-700 dark:text-gray-300 text-sm leading-relaxed">
                ${introText}
            </p>
        </section>`;
}

/**
 * Generate FAQ section HTML for entity page SEO (uses native details/summary)
 * Includes questions where entity was mentioned
 */
function generateEntityFaqHtml(..._args: unknown[]): string {
  return "";
}

/**
 * Build FAQ JSON-LD structure for entity page
 */
function buildEntityFaqJsonLd(faqs: Array<{ question: string; answer: string }>): object {
  return {
    "@type": "FAQPage",
    "mainEntity": faqs.map(faq => ({
      "@type": "Question",
      "name": faq.question,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": faq.answer
      }
    }))
  };
}

/**
 * Configuration for entity page generation
 */
export interface EntityPageConfig {
  project: string;
  questionId: string;
  targetDate: string;
  outputDir: string;
  templateDir: string;
  enrichedDataFile: string;
  baseUrl?: string;  // Base URL for absolute URLs in JSON-LD (e.g., https://aicw.io/ranking/Project/questionId/)
}

/**
 * Generate entity pages for all brands in the report
 * @returns Number of entity pages generated
 */
export async function generateEntityPages(config: EntityPageConfig): Promise<number> {
  const { project, questionId, targetDate, outputDir, templateDir, enrichedDataFile, baseUrl } = config;

  // Load data from the enriched data file
  const { data } = await loadDataJs(enrichedDataFile);

  // Get brands array
  const brands = data.brands;
  if (!brands || !Array.isArray(brands) || brands.length === 0) {
    logger.debug(`No brands found in ${questionId}, skipping entity pages`);
    return 0;
  }

  // Get bots array for model information
  const bots = data.bots || [];

  // Get link domains count for FAQ context
  const linkDomains = data.linkDomains || [];
  const totalDomains = Array.isArray(linkDomains) ? linkDomains.length : 0;

  // Load questions to enrich excerpts with full question text
  const questions = await readQuestions(project);
  const questionsByPrompt: Record<string, string> = {};
  for (const q of questions) {
    questionsByPrompt[q.folder] = q.question;
  }

  // Calculate ranks based on influence (share of voice)
  const sortedBrands = [...brands].sort((a, b) => (b.influence || 0) - (a.influence || 0));
  const rankMap = new Map(sortedBrands.map((b, i) => [b.value, i + 1]));

  // Create mention output directory
  const rankingDir = path.join(outputDir, 'mention');
  await fs.mkdir(rankingDir, { recursive: true });

  // Read entity page template
  const entityTemplateDir = path.join(templateDir, 'mention');
  const templatePath = path.join(entityTemplateDir, 'mention-page.html');

  let template: string;
  try {
    template = await fs.readFile(templatePath, 'utf-8');
  } catch (err) {
    logger.warn(`Entity page templates not found at ${templatePath}, skipping entity pages`);
    return 0;
  }

  // Load custom footer code (once for all entity pages)
  const customFooterCode = await loadCustomFooterCode('mention-page');

  // Generate report meta
  const reportMeta = {
    projectName: project,
    questionId,
    reportDate: targetDate,
  };

  let generatedCount = 0;

  // Generate page for each brand
  for (const entity of brands) {
    const entityName = entity.value || entity.code || '';
    if (!entityName) continue;

    const slug = slugify(entityName);
    if (!slug) continue;

    try {
      // Enrich excerpts with full question text
      const enrichedExcerptsByModel: Record<string, unknown[]> = {};
      for (const [modelId, excerpts] of Object.entries(entity.excerptsByModel || {})) {
        enrichedExcerptsByModel[modelId] = (excerpts as Array<{ promptId?: string }>).map(excerpt => ({
          ...excerpt,
          question: excerpt.promptId ? questionsByPrompt[excerpt.promptId] || null : null
        }));
      }

      // Create entity-specific data with rank
      const entityData = {
        ...entity,
        rank: rankMap.get(entityName) || 0,
        // Use enriched excerpts with question text
        excerptsByModel: enrichedExcerptsByModel
      };

      // Build canonical URL (relative for now)
      const canonicalUrl = `mention/${slug}.html`;

      // Calculate entity stats for macros
      const entityRank = rankMap.get(entityName) || 0;
      const entityInfluence = formatPercent(entity.influence);
      const botCount = countBots(entity);

      // Determine which questions this entity is mentioned in
      const entityQuestionIds = new Set<string>();
      for (const excerpts of Object.values(entity.excerptsByModel || {})) {
        for (const excerpt of excerpts as Array<{ promptId?: string }>) {
          if (excerpt.promptId) {
            entityQuestionIds.add(excerpt.promptId);
          }
        }
      }
      const entityQuestions = Array.from(entityQuestionIds)
        .filter(id => questionsByPrompt[id])
        .map(id => ({ id, text: questionsByPrompt[id] }));

      // Generate SEO sections: Introduction and FAQ
      const introHtml = generateEntityIntroHtml(entity, entityRank, brands.length, bots, {
        reportDate: targetDate,
        questions: entityQuestions,
        basePath: '../'
      });
      const botNames = bots.map(b => b.name);
      const faqHtml = generateEntityFaqHtml(entity, entityRank, brands.length, botNames, {
        questions: entityQuestions,
        basePath: '../',
        totalDomains,
        bots
      });

      // Build FAQs for JSON-LD
      const aiList = botNames.slice(0, 5).join(', ') + (botNames.length > 5 ? ', and more' : '');
      const entityType = (entity.type || 'brand') as string;
      const mentions = entity.mentions as number || 0;
      const questionsListText = entityQuestions.map((q, i) => `${i + 1}. "${q.text}"`).join('; ');
      const modelWeightsSummary = buildModelWeightsSummary(bots);
      const faqsForJsonLd = [
        {
          question: `How many times was ${entityName} mentioned by AI?`,
          answer: `${entityName} was mentioned ${mentions} times across all AI models analyzed, representing ${entityInfluence} of total mentions.`
        },
        {
          question: `Which AI models mention ${entityName}?`,
          answer: `${entityName} is mentioned by ${botCount} AI models including ${aiList}.`
        },
        ...(entityQuestions.length > 0 ? [{
          question: `In which questions is ${entityName} mentioned?`,
          answer: `${entityName} appears in ${entityQuestions.length} question${entityQuestions.length !== 1 ? 's' : ''}: ${questionsListText}.`
        }] : []),
        {
          question: `What is ${entityName}'s ranking among mentioned brands?`,
          answer: `${entityName} ranks #${entityRank} out of ${brands.length} brands analyzed${totalDomains > 0 ? ` (with ${totalDomains} web sources also tracked)` : ''}, with a ${entityInfluence} share of voice.`
        },
        {
          question: `What type of entity is ${entityName}?`,
          answer: `${entityName} is classified as a ${entityType}.`
        },
        {
          question: 'How is Share of Voice calculated?',
          answer: `Share of Voice = Model Coverage × Quality Score. Model weights are based on Monthly Active Users${modelWeightsSummary ? ` (${modelWeightsSummary})` : ''}. Position in results matters - earlier mentions receive higher prominence scores.`
        }
      ];

      // Build data for rich JSON-LD description
      const mentioningBotNames = getMentioningBotNames(entity, bots);
      const botNamesForJsonLd = mentioningBotNames.slice(0, 5).join(', ') + (mentioningBotNames.length > 5 ? ', and more' : '');
      const questionsListForJsonLd = entityQuestions.map(q => `"${q.text}"`).join(', ');
      const formattedDateForJsonLd = formatDateHuman(targetDate);

      // Build JSON-LD structured data with FAQ
      const jsonLdData = buildJsonLd(
        { ...entity, rank: entityRank },
        {
          canonicalUrl,
          projectName: project,
          reportDate: targetDate,
          entityType,
          botNames: botNamesForJsonLd,
          questionsList: questionsListForJsonLd,
          questionCount: entityQuestions.length,
          formattedDate: formattedDateForJsonLd,
          baseUrl
        },
        brands.length,
        []
      );

      // Generate static HTML for SEO/noscript
      const heroHtml = generateHeroHtml(entity, entityRank);
      const metricsCardsHtml = generateMetricsCardsHtml(entity, entityRank);
      const modelTableRowsHtml = generateModelTableRowsHtml(entity, bots);
      // NEW: Generate full static content (not just noscript fallback)
      const questionsHtml = generateQuestionsHtml(entity, questionsByPrompt);
      const sourceLinksHtml = generateSourceLinksHtml(entity, bots);
      const excerptsHtml = generateExcerptsHtml(entity, bots, questionsByPrompt);

      // Create URL-safe slug for UTM parameters
      const projectSlug = project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      // Replace macros in template
      const replacements: Record<string, string> = {
        '{{ENTITY_NAME}}': entityName,
        '{{ENTITY_TYPE}}': entity.type || 'brand',
        '{{ENTITY_MENTIONS}}': String(entity.mentions || 0),
        '{{ENTITY_RANK}}': String(entityRank),
        '{{ENTITY_INFLUENCE}}': entityInfluence,
        '{{BOT_COUNT}}': String(botCount),
        '{{TOTAL_ENTITIES}}': String(brands.length),
        '{{PROJECT_NAME}}': project,
        '{{PROJECT_NAME_SLUG}}': projectSlug,
        '{{CANONICAL_URL}}': `${slug}.html`,
        '{{REPORT_DATE_ISO}}': targetDate,
        '{{REPORT_DATE_WITHOUT_DASHES}}': targetDate.replace(/-/g, ''),
        '{{REPORT_ENGINE_VERSION}}': getCurrentVersion(),
        '{{JSON_LD_DATA}}': jsonLdData,
        '{{STATIC_HERO_HTML}}': heroHtml,
        '{{STATIC_METRICS_CARDS_HTML}}': metricsCardsHtml,
        '{{STATIC_MODEL_TABLE_ROWS_HTML}}': modelTableRowsHtml,
        // Questions: compact indicator + modal
        '{{STATIC_QUESTIONS_HTML}}': questionsHtml.indicator,
        '{{STATIC_QUESTIONS_MODAL_HTML}}': questionsHtml.modal,
        '{{STATIC_SOURCE_LINKS_HTML}}': sourceLinksHtml,
        '{{STATIC_EXCERPTS_HTML}}': excerptsHtml,
        '{{STATIC_INTRO_HTML}}': introHtml,
        '{{STATIC_FAQ_HTML}}': faqHtml,
        '{{ENTITY_JSON}}': JSON.stringify(entityData),
        '{{BOTS_JSON}}': JSON.stringify(bots),
        '{{REPORT_META_JSON}}': JSON.stringify(reportMeta),
        '{{FOOTER_CUSTOM_CODE}}': customFooterCode,
      };

      const htmlContent = await replaceMacrosInTemplate(template, replacements, false);

      // Write entity page
      const entityPagePath = path.join(rankingDir, `${slug}.html`);
      await writeFileAtomic(entityPagePath, htmlContent);

      generatedCount++;
    } catch (entityError) {
      logger.debug(`Failed to generate page for entity ${entityName}: ${entityError instanceof Error ? entityError.message : String(entityError)}`);
      // Continue with other entities
    }
  }

  logger.debug(`Generated ${generatedCount} entity pages in ${rankingDir}`);
  return generatedCount;
}
