/**
 * Source domain page generation utilities
 * Generates individual HTML pages for each link domain (linkDomain)
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
 * Count how many bots cited this domain
 */
function countBots(domain: Record<string, unknown>): number {
  if (domain.bots && typeof domain.bots === 'string') {
    return (domain.bots as string).split(',').filter((b: string) => b.trim()).length;
  }
  if (domain.mentionsByModel && typeof domain.mentionsByModel === 'object') {
    return Object.keys(domain.mentionsByModel as Record<string, number>).filter(
      k => (domain.mentionsByModel as Record<string, number>)[k] > 0
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
 * Get names of bots that cite this link domain
 */
function getMentioningBotNames(domain: Record<string, unknown>, bots: Array<{ id: string; name: string }>): string[] {
  const mentionsByModel = domain.mentionsByModel as Record<string, number> || {};
  const domainBots = domain.bots ? (domain.bots as string).split(',').map(b => b.trim()) : [];
  return bots
    .filter(bot => domainBots.includes(bot.id) || (mentionsByModel[bot.id] && mentionsByModel[bot.id] > 0))
    .map(bot => bot.name);
}

/**
 * Build JSON-LD structured data for a link domain page
 * Enhanced with FAQPage schema for SEO
 */
function buildJsonLd(
  domain: Record<string, unknown>,
  meta: {
    canonicalUrl: string;
    projectName: string;
    reportDate: string;
    linkType: string;
    botNames: string;
    questionsList: string;
    questionCount: number;
    formattedDate: string;
    referencingBrands: Array<{ value: string }>;
    baseUrl?: string;  // Base URL for absolute URLs (e.g., https://aicw.io/ranking/Project/questionId/)
  },
  totalDomains: number,
  faqs?: Array<{ question: string; answer: string }>
): string {
  const domainName = (domain.value || domain.code || '') as string;
  const rank = domain.rank as number || 0;
  const mentions = domain.mentions as number || 0;
  const influence = formatPercent(domain.influence as number);
  const link = domain.link as string | undefined;

  // Build rich description for source (plain text, no HTML)
  let richDescription = `${domainName} (${meta.linkType}) was ranked #${rank} out of ${totalDomains} link domains (${mentions} citations, ${influence} share) in answers from AI models (${meta.botNames}) when asked the following ${meta.questionCount} question${meta.questionCount !== 1 ? 's' : ''}: ${meta.questionsList} on ${meta.formattedDate}.`;
  if (meta.referencingBrands.length > 0) {
    const brandNames = meta.referencingBrands.slice(0, 5).map(b => b.value).join(', ');
    richDescription += ` This source is referenced for brands: ${brandNames}${meta.referencingBrands.length > 5 ? ` +${meta.referencingBrands.length - 5} more` : ''}.`;
  }

  // Build URL with https:// prefix if needed
  const domainUrl = link ? (link.startsWith('http') ? link : `https://${link}`) : `https://${domainName}`;

  // Build about array for referenced brands
  const aboutBrands = meta.referencingBrands.slice(0, 10).map(b => ({
    "@type": "Thing",
    "name": b.value
  }));

  // Build absolute URLs for JSON-LD (Google requires absolute URLs for @id fields)
  const absoluteCanonicalUrl = meta.baseUrl ? `${meta.baseUrl}${meta.canonicalUrl}` : meta.canonicalUrl;
  const absoluteIndexUrl = meta.baseUrl ? `${meta.baseUrl}index.html` : '../index.html';

  const graph: object[] = [
    {
      "@type": "WebPage",
      "@id": `${absoluteCanonicalUrl}#webpage`,
      "url": absoluteCanonicalUrl,
      "name": `${domainName} - Link Domain Analysis`,
      "description": `${domainName} cited ${mentions} times by AI models. Rank #${rank} of ${totalDomains} with ${influence} share of voice.`,
      "datePublished": meta.reportDate,
      "isPartOf": {
        "@type": "WebSite",
        "name": "AICW AI Mentions",
        "url": "https://aicw.io"
      },
      "mainEntity": { "@id": `${absoluteCanonicalUrl}#website` }
    },
    {
      "@type": "WebSite",
      "@id": `${absoluteCanonicalUrl}#website`,
      "name": domainName,
      "description": richDescription,
      "url": domainUrl,
      ...(aboutBrands.length > 0 ? { "about": aboutBrands } : {})
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": meta.projectName, "item": absoluteIndexUrl },
        { "@type": "ListItem", "position": 2, "name": "Link Domains", "item": `${absoluteIndexUrl}#panel-domains` },
        { "@type": "ListItem", "position": 3, "name": domainName, "item": absoluteCanonicalUrl }
      ]
    }
  ];

  // Add FAQPage schema if FAQs provided
  if (faqs && faqs.length > 0) {
    graph.push(buildSourceFaqJsonLd(faqs));
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
 * Order matches main report table columns: Rank, Voice, Position, Citations, AI
 */
function generateMetricsCardsHtml(domain: Record<string, unknown>, domainRank: number): string {
  const mentions = domain.mentions as number || 0;
  const mentionsAsPercent = formatPercent(domain.mentionsAsPercent as number);
  const influence = formatPercent(domain.influence as number);
  const position = domain.appearanceOrder !== undefined
    ? `${Math.round(domain.appearanceOrder as number)}`
    : 'N/A';
  const bots = countBots(domain);

  // Get trend indicators
  const influenceTrend = getTrendIcon(domain.influenceTrend as number | undefined);
  const positionTrend = getTrendIcon(domain.appearanceOrderTrend as number | undefined);
  const mentionsTrend = getTrendIcon(domain.mentionsTrend as number | undefined);

  return `
    <div class="metric-card-sm">
        <div class="metric-value-sm">#${domainRank}</div>
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
        <div class="metric-label-sm">Citations</div>
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
function generateModelTableRowsHtml(domain: Record<string, unknown>, bots: Array<{ id: string; name: string }>): string {
  const mentionsByModel = domain.mentionsByModel as Record<string, number> || {};
  const influenceByModel = domain.influenceByModel as Record<string, number> || {};
  const appearanceOrderByModel = domain.appearanceOrderByModel as Record<string, number> || {};
  const domainBots = domain.bots ? (domain.bots as string).split(',').map(b => b.trim()) : [];

  // Get bots with data for this domain
  const botsWithData = bots.filter(bot => {
    if (domainBots.includes(bot.id)) return true;
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
    const iconUrl = getModelIconUrlFromBot(bot);

    return `
            <tr>
                <td class="flex items-center gap-2">
                    <img src="${iconUrl}" alt="" class="w-5 h-5 rounded" onerror="this.style.display='none'">
                    ${escapeHtml(bot.name)}
                </td>
                <td class="text-center">${influence}</td>
                <td class="text-center">${position}</td>
                <td class="text-center">${mentions}</td>
            </tr>`;
  }).join('');
}

/**
 * Generate static hero section HTML (for noscript/SEO)
 */
function generateHeroHtml(domain: Record<string, unknown>, domainRank: number): string {
  const domainName = escapeHtml((domain.value || domain.code || '') as string);
  const linkTypeName = escapeHtml((domain.linkTypeName || '') as string);
  const influence = formatPercent(domain.influence as number);
  const link = domain.link as string | undefined;

  let logoHtml = '';
  if (domainName) {
    logoHtml = `
                        <div class="flex-shrink-0 w-16 h-16 md:w-20 md:h-20 bg-white rounded-xl p-2 shadow-lg">
                            <img src="https://www.google.com/s2/favicons?domain=${domainName}&sz=128"
                                 class="w-full h-full object-contain"
                                 alt="${domainName}"
                                 onerror="this.parentElement.style.display='none';" />
                        </div>`;
  }

  let linkTypeHtml = '';
  if (linkTypeName) {
    linkTypeHtml = `
                            <span class="inline-block px-3 py-1 rounded-full text-xs font-semibold bg-white/20 mb-2">
                                ${linkTypeName}
                            </span>`;
  }

  let visitLinkHtml = '';
  if (link) {
    visitLinkHtml = `
                            <a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"
                               class="text-white/80 hover:text-white flex items-center gap-2 mt-2 text-sm md:text-base" style="color: rgba(255,255,255,0.8) !important;">
                                <i class="fas fa-external-link-alt"></i>
                                Visit ${domainName}
                            </a>`;
  }

  return `
            <div class="bg-gradient-to-br from-teal-600 via-cyan-600 to-blue-500 rounded-2xl shadow-2xl p-6 md:p-8 text-white">
                <div class="flex flex-col md:flex-row items-start md:items-center gap-6">
                    <!-- Large Rank Badge -->
                    <div class="flex-shrink-0 w-20 h-20 md:w-28 md:h-28 bg-white/20 backdrop-blur rounded-2xl flex items-center justify-center border-4 border-white/30">
                        <span class="text-4xl md:text-5xl font-black">#${domainRank}</span>
                    </div>

                    <!-- Domain Logo + Info -->
                    <div class="flex flex-col md:flex-row items-start md:items-center gap-4 md:gap-6 flex-1">
                        <!-- Large Favicon/Logo -->${logoHtml}

                        <!-- Domain Name & Type -->
                        <div class="flex-1">${linkTypeHtml}
                            <h1 class="text-3xl md:text-4xl font-black">${domainName}</h1>${visitLinkHtml}
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
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Highlight domain name and source links in text
 */
function highlightDomain(text: string, domainName: string, sources?: Array<{ link?: string }>): string {
  if (!text) return '';

  // Collect all links to highlight
  const linksToHighlight: string[] = [];

  // Add all full links from sources
  if (sources && Array.isArray(sources)) {
    for (const source of sources) {
      if (source.link) {
        linksToHighlight.push(source.link);
      }
    }
  }

  // Add the domain name as fallback
  if (domainName) {
    linksToHighlight.push(domainName);
  }

  // Sort by length (longest first) to avoid partial highlights
  linksToHighlight.sort((a, b) => b.length - a.length);

  // Apply highlights
  let result = text;
  for (const link of linksToHighlight) {
    const regex = new RegExp(`(${escapeRegex(link)})`, 'gi');
    result = result.replace(regex, '<mark class="domain-highlight">$1</mark>');
  }

  return result;
}

/**
 * Generate static HTML for questions section
 * NOTE: Questions are now shown in the About section, so this returns empty
 * Keeping function for backward compatibility with template placeholders
 */
function generateQuestionsHtml(
  domain: Record<string, unknown>,
  questionsByPrompt: Record<string, string>
): { indicator: string; modal: string; questions: Array<{ id: string; text: string }> } {
  const excerptsByModel = domain.excerptsByModel as Record<string, Array<{ promptId?: string }>> || {};

  // Collect unique questions from excerpts (still needed for About section)
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
 * Generate static HTML for "Pages from this Domain" section
 */
function generatePagesFromDomainHtml(domain: Record<string, unknown>): string {
  const sources = domain.sources as Array<{ link?: string; mentions?: number; appearanceOrder?: number }> | undefined;

  if (!sources || !Array.isArray(sources) || sources.length === 0) {
    return '';
  }

  const domainName = (domain.value || domain.code || '') as string;

  let html = `
            <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                <h2 class="text-xl font-bold mb-4 text-gray-900 dark:text-white">
                    <i class="fas fa-link mr-2"></i>
                    Pages from ${escapeHtml(domainName)}
                    <span class="text-sm font-normal text-gray-500 ml-2">(${sources.length} link${sources.length !== 1 ? 's' : ''})</span>
                </h2>
                <div class="overflow-x-auto">
                    <table class="w-full">
                        <thead>
                            <tr>
                                <th>URL Path</th>
                                <th class="text-center">Citations</th>
                                <th class="text-center">Position</th>
                            </tr>
                        </thead>
                        <tbody>`;

  // Sort by position (ascending - smaller position first)
  const sortedSources = [...sources].sort((a, b) => {
    const posA = a.appearanceOrder ?? Infinity;
    const posB = b.appearanceOrder ?? Infinity;
    return posA - posB;
  });

  for (const source of sortedSources) {
    const link = source.link || '';
    const mentions = source.mentions || 0;
    const position = source.appearanceOrder !== undefined && source.appearanceOrder > 0
      ? parseFloat(source.appearanceOrder.toFixed(1)).toString()
      : 'N/A';

    // Format path - show path portion after domain
    let path = link;
    const domainEnd = link.indexOf('/');
    if (domainEnd !== -1) {
      path = link.substring(domainEnd) || '/';
    }

    html += `
                            <tr>
                                <td>
                                    <a href="https://${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"
                                       class="text-blue-600 hover:underline break-all">
                                        ${escapeHtml(path)}
                                    </a>
                                </td>
                                <td class="text-center">${mentions}</td>
                                <td class="text-center">${position}</td>
                            </tr>`;
  }

  html += `
                        </tbody>
                    </table>
                </div>
            </div>`;

  return html;
}

/**
 * Generate static HTML for "Brands Referenced By This Website" section
 */
function generateReferencingBrandsHtml(
  domain: Record<string, unknown>
): string {
  const referencingBrands = domain.referencingBrands as Array<{
    value: string;
    type?: string;
    link?: string;
    mentions?: number;
    influence?: number;
  }> | undefined;

  if (!referencingBrands || !Array.isArray(referencingBrands) || referencingBrands.length === 0) {
    return '';
  }

  let html = `
            <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                <h2 class="text-xl font-bold mb-4 text-gray-900 dark:text-white">
                    <i class="fas fa-tags mr-2"></i>
                    Brands Referenced By This Website
                    <span class="text-sm font-normal text-gray-500 ml-2">
                        (${referencingBrands.length} brand${referencingBrands.length !== 1 ? 's' : ''})
                    </span>
                </h2>
                <div class="overflow-x-auto">
                    <table class="w-full">
                        <thead>
                            <tr>
                                <th>Brand</th>
                                <th class="text-center">Voice</th>
                                <th class="text-center">Mentions</th>
                            </tr>
                        </thead>
                        <tbody>`;

  // Sort by influence (descending - largest first)
  const sortedBrands = [...referencingBrands].sort((a, b) => {
    const influenceA = a.influence || 0;
    const influenceB = b.influence || 0;
    return influenceB - influenceA;
  });

  for (const brand of sortedBrands) {
    const brandValue = brand.value || '';
    const mentions = brand.mentions || 0;
    const influence = formatPercent(brand.influence);

    // Create slug for brand page link
    const slug = brandValue.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Get brand domain for favicon
    let brandDomain = '';
    if (brand.link) {
      try {
        const url = brand.link.includes('://') ? brand.link : `https://${brand.link}`;
        brandDomain = new URL(url).hostname.replace('www.', '');
      } catch {
        brandDomain = brand.link.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      }
    }

    html += `
                            <tr>
                                <td class="flex items-center gap-2">`;

    if (brandDomain) {
      html += `
                                    <img src="https://www.google.com/s2/favicons?domain=${brandDomain}&sz=32"
                                         class="w-5 h-5 rounded"
                                         alt="${escapeHtml(brandValue)}"
                                         onerror="this.style.display='none'">`;
    }

    html += `
                                    <a href="../mention/${slug}.html"
                                       class="text-blue-600 hover:underline">
                                        ${escapeHtml(brandValue)}
                                    </a>
                                </td>
                                <td class="text-center">${influence}</td>
                                <td class="text-center">${mentions}</td>
                            </tr>`;
  }

  html += `
                        </tbody>
                    </table>
                </div>
            </div>`;

  return html;
}

/**
 * Generate static HTML for excerpts section (grouped by model)
 */
function generateExcerptsHtml(
  domain: Record<string, unknown>,
  bots: Array<{ id: string; name: string; url?: string }>,
  questionsByPrompt: Record<string, string>
): string {
  const excerptsByModel = domain.excerptsByModel as Record<string, Array<{
    promptId?: string;
    excerpt?: string;
    text?: string;
    appearanceOrder?: number;
    sourceLink?: string;
    captureDate?: string;
  }>> || {};

  const domainName = (domain.value || domain.code || '') as string;
  const sources = domain.sources as Array<{ link?: string }> | undefined;

  // Check if there are any excerpts
  const hasExcerpts = Object.values(excerptsByModel).some(e => e && e.length > 0);
  if (!hasExcerpts) {
    return '';
  }

  // Get bots with excerpts
  const botsWithExcerpts = bots.filter(bot => {
    const excerpts = excerptsByModel[bot.id];
    return excerpts && excerpts.length > 0;
  });

  if (botsWithExcerpts.length === 0) {
    return '';
  }

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

  let html = `
            <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                <h2 class="text-xl font-bold mb-4 text-gray-900 dark:text-white">
                    <i class="fas fa-quote-left mr-2"></i>
                    Citations from AI Responses
                </h2>`;

  for (const bot of botsWithExcerpts) {
    const excerpts = excerptsByModel[bot.id] || [];
    const iconUrl = getModelIconUrlFromBot(bot);

    html += `
                <div class="mb-6">
                    <h3 class="font-semibold text-lg mb-3 flex items-center gap-2 text-gray-800 dark:text-gray-200">
                        <img src="${iconUrl}" alt="" class="w-5 h-5 rounded" onerror="this.style.display='none'">
                        ${escapeHtml(bot.name)}
                        <span class="text-sm font-normal text-gray-500">(${excerpts.length} citation${excerpts.length !== 1 ? 's' : ''})</span>
                    </h3>`;

    // Group excerpts by promptId
    const groupedExcerpts: Record<string, typeof excerpts> = {};
    for (const excerpt of excerpts) {
      const key = excerpt.promptId || 'unknown';
      if (!groupedExcerpts[key]) groupedExcerpts[key] = [];
      groupedExcerpts[key].push(excerpt);
    }

    for (const [promptId, questionExcerpts] of Object.entries(groupedExcerpts)) {
      const questionText = promptId !== 'unknown' ? questionsByPrompt[promptId] : null;

      html += `
                    <div class="mb-4">`;

      if (questionText) {
        html += `
                        <p class="text-sm text-gray-500 dark:text-gray-400 mb-2 flex items-center">
                            <i class="fas fa-question-circle mr-2"></i>
                            <span class="italic">${escapeHtml(questionText)}</span>
                        </p>`;
      }

      for (const excerpt of questionExcerpts) {
        const excerptText = excerpt.excerpt || excerpt.text || '';
        const highlightedText = highlightDomain(escapeHtml(excerptText), domainName, sources);

        // Add truncation indicators
        const CONTEXT_CHARS = 300;
        let displayText = highlightedText;
        if ((excerpt.appearanceOrder || 0) > CONTEXT_CHARS) {
          displayText = '[...] ' + displayText;
        }
        displayText = displayText + ' [...]';

        html += `
                        <div class="citation-block">
                            <p class="citation-text">${displayText}</p>
                            <p class="citation-meta">`;

        if (excerpt.sourceLink) {
          html += `
                                <span class="mr-4">
                                    <i class="fas fa-link mr-1"></i> ${escapeHtml(excerpt.sourceLink)}
                                </span>`;
        }

        let formattedDate = '';
        if (excerpt.captureDate) {
          const date = new Date(excerpt.captureDate);
          formattedDate = date.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
          });
          html += `
                                <span>
                                    <i class="fas fa-calendar mr-1"></i> ${formattedDate}
                                </span>`;
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

      html += `
                    </div>`;
    }

    html += `
                </div>`;
  }

  html += `
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
 * Generate introduction/about section HTML for source page SEO
 * Uses natural language format with inline AI icons
 */
function generateSourceIntroHtml(
  domain: Record<string, unknown>,
  domainRank: number,
  totalDomains: number,
  bots: Array<{ id: string; name: string; url?: string }>,
  referencingBrands: string[],
  config: {
    reportDate: string;
    questions?: Array<{ id: string; text: string }>;
    basePath?: string;
  }
): string {
  const { reportDate, questions = [], basePath = '../' } = config;
  const domainName = escapeHtml((domain.value || domain.code || '') as string);
  const linkType = (domain.linkTypeName || 'source') as string;
  const mentions = domain.mentions as number || 0;
  const influence = formatPercent(domain.influence as number);
  const formattedDate = formatDateHuman(reportDate);

  // Get domain's mentioning bots
  const mentionsByModel = domain.mentionsByModel as Record<string, number> || {};
  const domainBots = domain.bots ? (domain.bots as string).split(',').map(b => b.trim()) : [];
  const mentioningBots = bots.filter(bot => {
    if (domainBots.includes(bot.id)) return true;
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

  // Build referencing brands list with links
  let brandsText = '';
  if (referencingBrands.length > 0) {
    const brandLinks = referencingBrands.slice(0, 5).map(b => {
      const brandSlug = slugify(b);
      return `<a href="${basePath}mention/${brandSlug}.html" class="text-indigo-600 hover:underline">${escapeHtml(b)}</a>`;
    });
    brandsText = brandLinks.join(', ');
    if (referencingBrands.length > 5) {
      brandsText += ` +${referencingBrands.length - 5} more`;
    }
  }

  // Build the natural language paragraph
  let introText = `This page provides details about <strong>${domainName}</strong> (${escapeHtml(linkType)}) which was ranked <strong>#${domainRank}</strong> out of ${totalDomains} link domains `;
  introText += `(${mentions} citation${mentions !== 1 ? 's' : ''} (${influence} share)) `;
  introText += `in answers from AI models (${aiModelsText})`;

  if (questionsText) {
    introText += ` when they were asked the following ${questions.length} question${questions.length !== 1 ? 's' : ''}: ${questionsText}`;
  }

  introText += ` on <strong>${formattedDate}</strong> by <a href="https://www.aicw.io/aicw-ai-mentions" class="text-indigo-600 hover:underline">AICW AI Mentions</a>.`;

  if (brandsText) {
    introText += ` This source is referenced for brands: ${brandsText}.`;
  }

  return `
        <section class="source-intro bg-white dark:bg-gray-800 rounded-lg shadow p-5 mb-4">
            <h2 class="text-lg font-bold mb-3 text-gray-900 dark:text-white">
                <i class="fas fa-info-circle mr-2 text-teal-500"></i>About ${domainName} (${escapeHtml(linkType)})
            </h2>
            <p class="text-gray-700 dark:text-gray-300 text-sm leading-relaxed">
                ${introText}
            </p>
        </section>`;
}

/**
 * Generate FAQ section HTML for source page SEO (uses native details/summary)
 * Includes clickable brand links
 */
function generateSourceFaqHtml(..._args: unknown[]): string {
  return "";
}

/**
 * Build FAQ JSON-LD structure for source page
 */
function buildSourceFaqJsonLd(faqs: Array<{ question: string; answer: string }>): object {
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
 * Configuration for source page generation
 */
export interface SourcePageConfig {
  project: string;
  questionId: string;
  targetDate: string;
  outputDir: string;
  templateDir: string;
  enrichedDataFile: string;
  baseUrl?: string;  // Base URL for absolute URLs in JSON-LD (e.g., https://aicw.io/ranking/Project/questionId/)
}

/**
 * Generate source pages for all domains in the report
 * @returns Number of source pages generated
 */
export async function generateSourcePages(config: SourcePageConfig): Promise<number> {
  const { project, questionId, targetDate, outputDir, templateDir, enrichedDataFile, baseUrl } = config;

  // Load data from the enriched data file
  const { data } = await loadDataJs(enrichedDataFile);

  // Get linkDomains array
  const linkDomains = data.linkDomains;
  if (!linkDomains || !Array.isArray(linkDomains) || linkDomains.length === 0) {
    logger.debug(`No linkDomains found in ${questionId}, skipping source pages`);
    return 0;
  }

  // Get bots array for model information
  const bots = data.bots || [];

  // Get brands/entities for cross-referencing
  const brands = data.brands || data.entities || [];

  // Load questions to enrich excerpts with full question text
  const questions = await readQuestions(project);
  const questionsByPrompt: Record<string, string> = {};
  for (const q of questions) {
    questionsByPrompt[q.folder] = q.question;
  }

  // Calculate ranks based on influence (share of voice)
  const sortedDomains = [...linkDomains].sort((a, b) => (b.influence || 0) - (a.influence || 0));
  const rankMap = new Map(sortedDomains.map((d, i) => [d.value, i + 1]));

  // Create website output directory
  const sourcesDir = path.join(outputDir, 'website');
  await fs.mkdir(sourcesDir, { recursive: true });

  // Read source page template
  const sourceTemplateDir = path.join(templateDir, 'website');
  const templatePath = path.join(sourceTemplateDir, 'source-page.html');

  let template: string;
  try {
    template = await fs.readFile(templatePath, 'utf-8');
  } catch (err) {
    logger.warn(`Source page templates not found at ${templatePath}, skipping source pages`);
    return 0;
  }

  // Copy answers file to sources directory for full answer expansion
  const answersFileName = `${targetDate}-answers.js`;
  const answersFileSrc = path.join(outputDir, answersFileName);
  const answersFileDest = path.join(sourcesDir, answersFileName);
  try {
    await fs.copyFile(answersFileSrc, answersFileDest);
    logger.debug(`Copied answers file to sources directory: ${answersFileName}`);
  } catch (err) {
    logger.debug('Answers file not found, full answer expansion will be disabled');
  }

  // Load custom footer code (once for all source pages)
  const customFooterCode = await loadCustomFooterCode('source-page');

  // Generate report meta
  const reportMeta = {
    projectName: project,
    questionId,
    reportDate: targetDate,
  };

  let generatedCount = 0;

  // Generate page for each domain
  for (const domain of linkDomains) {
    const domainName = domain.value || domain.code || '';
    if (!domainName) continue;

    const slug = slugify(domainName);
    if (!slug) continue;

    try {
      // Find brands that reference this domain in their sources
      const referencingBrands = (brands as Array<Record<string, unknown>>)
        .filter((brand) => {
          const sources = brand.sources as Array<{ url?: string; link?: string }> | undefined;
          if (!sources || !Array.isArray(sources)) return false;
          return sources.some((source) => {
            const url = source.url || source.link || '';
            return url.toLowerCase().includes(domainName.toLowerCase());
          });
        })
        .map((brand) => ({
          value: brand.value as string,
          type: brand.type as string,
          link: brand.link as string | undefined,
          mentions: brand.mentions as number,
          influence: brand.influence as number,
        }));

      // Enrich excerpts with full question text
      const enrichedExcerptsByModel: Record<string, unknown[]> = {};
      for (const [modelId, excerpts] of Object.entries(domain.excerptsByModel || {})) {
        enrichedExcerptsByModel[modelId] = (excerpts as Array<{ promptId?: string }>).map(excerpt => ({
          ...excerpt,
          question: excerpt.promptId ? questionsByPrompt[excerpt.promptId] || null : null
        }));
      }

      // Create domain-specific data with rank and referencing brands
      const domainData = {
        ...domain,
        rank: rankMap.get(domainName) || 0,
        // Ensure excerptsByModel is enriched with question text
        excerptsByModel: enrichedExcerptsByModel,
        // Add brands that cite this source
        referencingBrands,
      };

      // Build canonical URL (relative for now)
      const canonicalUrl = `website/${slug}.html`;

      // Calculate domain stats for macros
      const domainRank = rankMap.get(domainName) || 0;
      const domainInfluence = formatPercent(domain.influence);
      const botCount = countBots(domain);

      // Extract referencing brand names for SEO content
      const referencingBrandNames = referencingBrands.map(b => b.value);

      // Get questions where this domain was cited
      const questionsResult = generateQuestionsHtml(domainData, questionsByPrompt);
      const domainQuestions = questionsResult.questions;

      // Generate SEO sections: Introduction and FAQ
      const introHtml = generateSourceIntroHtml(domain, domainRank, linkDomains.length, bots, referencingBrandNames, {
        reportDate: targetDate,
        questions: domainQuestions,
        basePath: '../'
      });
      const botNames = bots.map(b => b.name);
      const faqHtml = generateSourceFaqHtml(domain, domainRank, linkDomains.length, botNames, referencingBrandNames, {
        basePath: '../',
        totalBrands: brands.length,
        bots
      });

      // Build FAQs for JSON-LD
      const aiList = botNames.slice(0, 5).join(', ') + (botNames.length > 5 ? ', and more' : '');
      const brandsText = referencingBrandNames.length > 0
        ? referencingBrandNames.slice(0, 3).join(', ') + (referencingBrandNames.length > 3 ? ', and others' : '')
        : 'various brands';
      const mentions = domain.mentions as number || 0;
      const modelWeightsSummary = buildModelWeightsSummary(bots);
      const faqsForJsonLd = [
        {
          question: `How often is ${domainName} cited by AI models?`,
          answer: `${domainName} was cited ${mentions} times by AI models, representing ${domainInfluence} of all link-domain citations.`
        },
        {
          question: `Which AI models cite ${domainName}?`,
          answer: `${domainName} is cited by ${botCount} AI models including ${aiList}.`
        },
        {
          question: `What is ${domainName}'s ranking among link domains?`,
          answer: `${domainName} ranks #${domainRank} out of ${linkDomains.length} link domains analyzed${brands.length > 0 ? ` (with ${brands.length} brands also tracked)` : ''}.`
        },
        {
          question: `What brands are associated with ${domainName}?`,
          answer: `AI models reference ${domainName} when discussing brands like ${brandsText}.`
        },
        {
          question: 'How is link domain ranking determined?',
          answer: `Link domains are ranked by Share of Voice = Model Coverage × Quality Score. Model weights are based on Monthly Active Users${modelWeightsSummary ? ` (${modelWeightsSummary})` : ''}. Domains appearing earlier in AI responses receive higher prominence scores.`
        }
      ];

      // Build data for rich JSON-LD description
      const mentioningBotNames = getMentioningBotNames(domain, bots);
      const botNamesForJsonLd = mentioningBotNames.slice(0, 5).join(', ') + (mentioningBotNames.length > 5 ? ', and more' : '');
      const questionsListForJsonLd = domainQuestions.map(q => `"${q.text}"`).join(', ');
      const formattedDateForJsonLd = formatDateHuman(targetDate);
      const linkTypeName = (domain.linkTypeName || 'source') as string;

      // Build JSON-LD structured data with FAQ
      const jsonLdData = buildJsonLd(
        { ...domain, rank: domainRank },
        {
          canonicalUrl,
          projectName: project,
          reportDate: targetDate,
          linkType: linkTypeName,
          botNames: botNamesForJsonLd,
          questionsList: questionsListForJsonLd,
          questionCount: domainQuestions.length,
          formattedDate: formattedDateForJsonLd,
          referencingBrands,
          baseUrl
        },
        linkDomains.length,
        []
      );

      // Generate static HTML for SEO/noscript
      const heroHtml = generateHeroHtml(domain, domainRank);
      const metricsCardsHtml = generateMetricsCardsHtml(domain, domainRank);
      const modelTableRowsHtml = generateModelTableRowsHtml(domain, bots);
      // Use cached questionsResult from above (now returns empty strings for badge/modal)
      const pagesFromDomainHtml = generatePagesFromDomainHtml(domainData);
      const referencingBrandsHtml = generateReferencingBrandsHtml(domainData);
      const excerptsHtml = generateExcerptsHtml(domainData, bots, questionsByPrompt);

      // Create URL-safe slug for UTM parameters
      const projectSlug = project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      // Replace macros in template
      const replacements: Record<string, string> = {
        '{{DOMAIN_NAME}}': domainName,
        '{{DOMAIN_MENTIONS}}': String(domain.mentions || 0),
        '{{DOMAIN_RANK}}': String(domainRank),
        '{{DOMAIN_INFLUENCE}}': domainInfluence,
        '{{BOT_COUNT}}': String(botCount),
        '{{TOTAL_DOMAINS}}': String(linkDomains.length),
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
        '{{STATIC_QUESTIONS_HTML}}': questionsResult.indicator,
        '{{STATIC_QUESTIONS_MODAL_HTML}}': questionsResult.modal,
        '{{STATIC_PAGES_FROM_DOMAIN_HTML}}': pagesFromDomainHtml,
        '{{STATIC_REFERENCING_BRANDS_HTML}}': referencingBrandsHtml,
        '{{STATIC_EXCERPTS_HTML}}': excerptsHtml,
        '{{STATIC_INTRO_HTML}}': introHtml,
        '{{STATIC_FAQ_HTML}}': faqHtml,
        '{{DOMAIN_JSON}}': JSON.stringify(domainData),
        '{{BOTS_JSON}}': JSON.stringify(bots),
        '{{REPORT_META_JSON}}': JSON.stringify(reportMeta),
        '{{FOOTER_CUSTOM_CODE}}': customFooterCode,
      };

      const htmlContent = await replaceMacrosInTemplate(template, replacements, false);

      // Write source page
      const sourcePagePath = path.join(sourcesDir, `${slug}.html`);
      await writeFileAtomic(sourcePagePath, htmlContent);

      generatedCount++;
    } catch (domainError) {
      logger.debug(`Failed to generate page for domain ${domainName}: ${domainError instanceof Error ? domainError.message : String(domainError)}`);
      // Continue with other domains
    }
  }

  logger.debug(`Generated ${generatedCount} source pages in ${sourcesDir}`);
  return generatedCount;
}
