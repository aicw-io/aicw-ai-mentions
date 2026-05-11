/**
 * Static main report page generation utilities
 * Generates SEO-friendly static HTML for main index.html reports
 * (both aggregate and per-question)
 */

import { promises as fs } from 'fs';
import path from 'path';
import { slugify } from './slug-utils.js';
import { replaceMacrosInTemplate, writeFileAtomic, loadCustomFooterCode } from './misc-utils.js';
import { logger } from './compact-logger.js';
import { loadDataJs, readQuestions } from './project-utils.js';
import { getCurrentVersion } from './update-checker.js';
import { getCurrentDateTimeAsStringISO } from '../config/user-paths.js';
import { MAX_BRANDS_IN_REPORT, MAX_SOURCES_IN_REPORT } from '../config/constants.js';
import { getModelById } from '../ai-preset-manager.js';

const MAX_LINKS_IN_REPORT = 100;
const DISPLAY_LINK_MAX_LENGTH = 56;

/**
 * Format a decimal value as a percentage string
 */
function formatPercent(value: number | undefined | null): string {
  if (value === undefined || value === null) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
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

function truncateMiddle(value: string, maxLength: number = DISPLAY_LINK_MAX_LENGTH): string {
  if (value.length <= maxLength) return value;

  const separator = '...';
  const keep = maxLength - separator.length;
  const front = Math.ceil(keep * 0.62);
  const back = Math.floor(keep * 0.38);
  return `${value.slice(0, front)}${separator}${value.slice(-back)}`;
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
    return isoDate; // Fallback to original if parsing fails
  }
}

function formatDateHeader(isoDate: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).formatToParts(new Date(isoDate));
    const part = (type: string) => parts.find(p => p.type === type)?.value || '';
    return [part('year'), part('month'), part('day')].filter(Boolean).join(' ');
  } catch {
    return isoDate;
  }
}

function getResolvedModelId(bot: { id: string; model?: string }): string {
  if (bot.model) {
    return bot.model;
  }

  try {
    return getModelById(bot.id)?.model || '';
  } catch {
    return '';
  }
}

/**
 * Format large numbers with suffix (M for millions, B for billions)
 * Examples: 900000000 -> "900M", 45000000 -> "45M", 300000 -> "300K"
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
 * Build HTML list of model weights for FAQ
 * Shows all models used in this specific report with their MAU and calculated weight
 */
function buildModelWeightsHtml(bots: Array<{ id: string; name: string; estimated_mau?: number }>): string {
  // Show all models used in this report
  const botsWithMAU = bots
    .filter(b => b.estimated_mau && b.estimated_mau > 0)
    .sort((a, b) => (b.estimated_mau || 0) - (a.estimated_mau || 0));

  if (botsWithMAU.length === 0) return 'Model weights not available';

  // Calculate total MAU for weight percentages
  const totalMAU = botsWithMAU.reduce((sum, b) => sum + (b.estimated_mau || 0), 0);

  // Display ALL models used in this report
  return botsWithMAU.map(b => {
    const mau = formatMAU(b.estimated_mau);
    const weight = totalMAU > 0 ? ((b.estimated_mau || 0) / totalMAU * 100).toFixed(1) : '0';
    return `• ${escapeHtml(b.name)}: ${mau} MAU (~${weight}% weight)`;
  }).join('<br>');
}

/**
 * Build plain-text list of model weights for JSON-LD
 */
function buildModelWeightsText(bots: Array<{ id: string; name: string; estimated_mau?: number }>): string {
  const botsWithMAU = bots
    .filter(b => b.estimated_mau && b.estimated_mau > 0)
    .sort((a, b) => (b.estimated_mau || 0) - (a.estimated_mau || 0));

  if (botsWithMAU.length === 0) return 'Model weights not available';

  const totalMAU = botsWithMAU.reduce((sum, b) => sum + (b.estimated_mau || 0), 0);

  return botsWithMAU.map(b => {
    const mau = formatMAU(b.estimated_mau);
    const weight = totalMAU > 0 ? ((b.estimated_mau || 0) / totalMAU * 100).toFixed(1) : '0';
    return `${b.name}: ${mau} MAU (~${weight}% weight)`;
  }).join('; ');
}

/**
 * Get bot icon class based on bot ID
 */
function getBotIconClass(botId: string): string {
  const knownBots = ['google_gemini', 'perplexity_ai', 'brave_search', 'you_com', 'openai_searchgpt'];
  return knownBots.includes(botId) ? `icon_bot_${botId}` : 'icon_bot_unknown';
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    // Handle URLs without protocol
    const match = url.match(/^([^\/]+)/);
    return match ? match[1].replace('www.', '') : null;
  }
}

function makeClickableUrl(url: string): string {
  if (!url) return '#';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Get trend icon based on trend value
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
 * Get Google favicon URL for an AI model based on its ID
 */
function getModelIconUrl(botId: string): string {
  const domainMap: Record<string, string> = {
    'google_gemini': 'gemini.google.com',
    'perplexity_ai': 'perplexity.ai',
    'brave_search': 'brave.com',
    'you_com': 'you.com',
    'openai_searchgpt': 'openai.com',
    'openai_chatgpt': 'openai.com',
    'openai_gpt4': 'openai.com',
    'openai_gpt4o': 'openai.com',
    'anthropic_claude': 'anthropic.com',
    'anthropic_claude_sonnet': 'anthropic.com',
    'mistral_ai': 'mistral.ai',
    'cohere': 'cohere.com',
    'meta_llama': 'meta.ai'
  };
  const domain = domainMap[botId] || domainMap[botId.split('_')[0] + '_' + botId.split('_')[1]];
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : '';
}

function generateBotDeckHtml(botIds: string[], bots: Array<{ id: string; name: string; url?: string }>): string {
  if (!botIds || botIds.length === 0) return '';

  const title = botIds
    .map(id => bots.find(bot => bot.id === id)?.name || id)
    .join(', ');

  const icons = botIds.map(botId => {
    const bot = bots.find(b => b.id === botId);
    const botName = bot?.name || botId;
    const botUrl = bot?.url || '';
    const botDomain = extractDomain(botUrl);
    const initial = escapeHtml(botName.charAt(0).toUpperCase());

    if (botDomain) {
      return `<img src="https://www.google.com/s2/favicons?domain=${botDomain}&sz=32"
                  alt="${escapeHtml(botName)}"
                  title="${escapeHtml(botName)}"
                  onerror="this.style.display='none'">`;
    }

    return `<span class="icon_bot icon_bot_unknown" title="${escapeHtml(botName)}">${initial}</span>`;
  }).join('');

  return `<div class="icon-bot-deck-static" title="${escapeHtml(title)}">${icons}</div>`;
}

function getRowBotFilterAttributes(
  botIds: string[],
  bots: Array<{ id: string; name: string }>
): string {
  const uniqueBotIds = Array.from(new Set((botIds || []).filter(Boolean)));
  const botNames = uniqueBotIds.map(id => bots.find(bot => bot.id === id)?.name || id);

  return [
    `data-bot-ids="${escapeHtml(uniqueBotIds.join('|'))}"`,
    `data-bot-names="${escapeHtml(botNames.join('|'))}"`
  ].join(' ');
}

/**
 * Generate introduction/about section HTML for SEO
 * Uses natural language format with flowing prose and inline icons
 */
export function generateReportIntroHtml(config: {
  projectName: string;
  reportDate: string;
  brandsCount: number;
  domainsCount: number;
  questionsCount: number;
  bots: Array<{ id: string; name: string; model?: string }>;
  topBrands: Array<{ value: string; type: string; influence: number; link?: string }>;
  questions?: Array<{ id: string; text: string }>;
  isAggregate?: boolean;
  currentQuestionId?: string;
  basePath?: string; // For relative links (e.g., '../' for per-question reports)
}): string {
  const { bots, questions, isAggregate, currentQuestionId, basePath = '' } = config;

  // Format AI model names as a structured list, keeping both the alias and resolved API model visible.
  const aiModelItemsHtml = bots.map(bot => {
    const iconUrl = getModelIconUrl(bot.id);
    const icon = iconUrl
      ? `<img src="${iconUrl}" alt="" class="w-4 h-4 rounded flex-shrink-0" onerror="this.style.display='none'">`
      : '';
    const resolvedModelId = getResolvedModelId(bot);
    const modelDetails = resolvedModelId
      ? `${escapeHtml(bot.id)} (${escapeHtml(resolvedModelId)})`
      : escapeHtml(bot.id);
    const questionAttr = currentQuestionId ? ` data-question-id="${escapeHtml(currentQuestionId)}"` : '';
    const initial = escapeHtml(bot.name.charAt(0).toUpperCase() || '?');

    return `<li class="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-3 py-2">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
                <div class="flex items-center gap-2 font-medium text-gray-900 dark:text-white">
                    ${icon}<span>${escapeHtml(bot.name)}</span>
                </div>
                <code class="mt-1 inline-block text-xs px-1.5 py-0.5 rounded bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300">${modelDetails}</code>
            </div>
            <button type="button"
                class="inline-flex items-center justify-center gap-1.5 rounded-md border border-indigo-200 dark:border-indigo-800 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-white dark:bg-gray-800 hover:bg-indigo-50 dark:hover:bg-indigo-950"
                data-model-response-button
                data-model-id="${escapeHtml(bot.id)}"
                data-model-name="${escapeHtml(bot.name)}"
                data-model-icon="${escapeHtml(iconUrl)}"
                data-model-initial="${initial}"${questionAttr}
                onclick="openModelResponse(this)">
                <i class="fas fa-message"></i>
                <span>View Response</span>
            </button>
        </div>
    </li>`;
  }).join('');
  const aiModelsListHtml = `<ul class="mt-2 space-y-2">${aiModelItemsHtml}</ul>`;

  // Build questions list as HTML ordered list with small text
  let questionsListHtml = '';
  if (questions && questions.length > 0) {
    const questionItems = questions.map(q => {
      const questionUrl = isAggregate ? `${q.id}/index.html` : `${basePath}${q.id}/index.html`;
      return `<li><i>"${escapeHtml(q.text)}"</i> <a href="${questionUrl}" class="text-indigo-600 hover:underline">(view report)</a></li>`;
    }).join('');
    questionsListHtml = `<ol class="list-decimal list-inside mt-1 space-y-1 text-sm text-gray-700 dark:text-gray-300">${questionItems}</ol>`;
  }

  return `
        <section class="report-intro bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-6">
            <h2 class="text-lg font-bold mb-3 text-gray-900 dark:text-white">
                <i class="fas fa-info-circle mr-2"></i>About
            </h2>
            <div class="grid gap-4 text-sm text-gray-700 dark:text-gray-300">
                ${questionsListHtml ? `<div>
                    <div class="font-semibold text-gray-900 dark:text-white">Questions</div>
                    ${questionsListHtml}
                </div>` : ''}
                <div>
                    <div class="font-semibold text-gray-900 dark:text-white">Models</div>
                    ${aiModelsListHtml}
                </div>
            </div>
        </section>`;
}

/**
 * Generate FAQ section HTML for SEO (uses native details/summary)
 * Includes questions analyzed and clickable brand references
 */
export function generateReportFaqHtml(_config?: unknown): string {
  return "";
}

/**
 * Build FAQ JSON-LD schema structure
 */
function buildFaqJsonLd(faqs: Array<{ question: string; answer: string }>): object {
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
 * Build ItemList JSON-LD for brand rankings
 */
function buildItemListJsonLd(brands: Array<{ value: string; type?: string }>, listName: string): object {
  return {
    "@type": "ItemList",
    "name": listName,
    "itemListOrder": "https://schema.org/ItemListOrderDescending",
    "numberOfItems": Math.min(brands.length, 10),
    "itemListElement": brands.slice(0, 10).map((brand, index) => ({
      "@type": "ListItem",
      "position": index + 1,
      "name": brand.value,
      "description": `${brand.type || 'brand'} - ranked #${index + 1} by AI mention frequency`
    }))
  };
}

/**
 * Generate static HTML for metrics cards
 */
export function generateMetricsHtml(
  brandsCount: number,
  domainsCount: number,
  questionsCount: number,
  botsCount: number,
  isAggregate: boolean = false
): string {
  // Questions card is clickable only for aggregate reports with multiple questions
  const questionsCardClickable = isAggregate && questionsCount > 1;
  const questionsCardClass = questionsCardClickable ? 'metric-card metric-card-clickable' : 'metric-card';
  const questionsCardAttrs = questionsCardClickable
    ? 'onclick="openQuestionsModal()" title="Click to view questions"'
    : '';

  return `
            <div class="metric-card">
                <div class="metric-icon"><i class="fas fa-building"></i></div>
                <div class="metric-value">${brandsCount}</div>
                <div class="metric-label">Mentions</div>
            </div>
            <div class="metric-card">
                <div class="metric-icon"><i class="fas fa-globe"></i></div>
                <div class="metric-value">${domainsCount}</div>
                <div class="metric-label">Link Domains</div>
            </div>
            <div class="${questionsCardClass}" ${questionsCardAttrs}>
                <div class="metric-icon"><i class="fas fa-question-circle"></i></div>
                <div class="metric-value">${questionsCount}</div>
                <div class="metric-label">Questions</div>
            </div>
            <div class="metric-card">
                <div class="metric-icon"><i class="fas fa-robot"></i></div>
                <div class="metric-value">${botsCount}</div>
                <div class="metric-label">AI Models</div>
            </div>`;
}

/**
 * Generate static HTML for brands table rows
 */
export function generateBrandsTableHtml(
  brands: Array<Record<string, unknown>>,
  bots: Array<{ id: string; name: string; url?: string }>,
  maxRows: number = MAX_BRANDS_IN_REPORT
): string {
  if (!brands || brands.length === 0) {
    return '<tr><td colspan="5" class="text-center py-4 text-gray-500">No mentions found</td></tr>';
  }

  // Sort by influence descending
  const sortedBrands = [...brands]
    .filter(b => b.influence !== undefined && b.influence !== null)
    .sort((a, b) => ((b.influence as number) || 0) - ((a.influence as number) || 0))
    .slice(0, maxRows);

  return sortedBrands.map((brand, index) => {
    const value = escapeHtml((brand.value || brand.code || '') as string);
    const entityType = (brand.type || 'brand') as string;
    const influence = formatPercent(brand.influence as number);
    const influencePercent = ((brand.influence as number) || 0) * 100;
    const mentions = (brand.mentions as number) || 0;
    const mentionsAsPercent = (brand.mentionsAsPercent as number) || 0;
    const position = brand.appearanceOrder !== undefined
      ? `${Math.round(brand.appearanceOrder as number)}`
      : 'N/A';

    // Get trend values
    const influenceTrend = getTrendIcon(brand.influenceTrend as number | undefined);
    const positionTrend = getTrendIcon(brand.appearanceOrderTrend as number | undefined);
    const mentionsTrend = getTrendIcon(brand.mentionsTrend as number | undefined);

    // Get bots that mentioned this brand
    const brandBots = brand.bots
      ? (brand.bots as string).split(',').map(b => b.trim()).filter(Boolean)
      : [];

    // Link to entity page
    const entityPageUrl = `mention/${slugify(value)}.html`;

    // Get domain for favicon
    const link = brand.link as string | undefined;
    const domain = extractDomain(link);

    let faviconHtml = '';
    if (domain) {
      faviconHtml = `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32"
                         class="w-5 h-5 rounded flex-shrink-0"
                         alt=""
                         onerror="this.style.display='none'">`;
    }

    const botDeckHtml = generateBotDeckHtml(brandBots, bots);

    return `
                        <tr ${getRowBotFilterAttributes(brandBots, bots)}>
                            <td>
                                <div class="flex items-center gap-2">
                                    ${faviconHtml}
                                    <div class="flex flex-wrap items-center gap-2 min-w-0">
                                        <a href="${entityPageUrl}" class="font-medium hover:underline brand-name-link" title="${value}">${value}</a>
                                        ${entityType.split(',').map(t => `<span class="type-badge">${escapeHtml(t.trim())}</span>`).join('')}
                                    </div>
                                </div>
                            </td>
                            <td class="text-center">
                                <div class="influence-gauge">
                                    <span class="text-sm font-medium">${influence}${influenceTrend}</span>
                                    <div class="influence-bar">
                                        <div class="influence-fill" style="width: ${Math.min(influencePercent * 2, 100)}%"></div>
                                    </div>
                                </div>
                            </td>
                            <td class="text-center">${position}${positionTrend}</td>
                            <td class="text-center">${mentions} (${formatPercent(mentionsAsPercent)})${mentionsTrend}</td>
                            <td>
                                <div class="flex items-center justify-center">
                                    ${botDeckHtml}
                                </div>
                            </td>
                        </tr>`;
  }).join('');
}

/**
 * Generate static HTML for domains table rows
 */
export function generateDomainsTableHtml(
  domains: Array<Record<string, unknown>>,
  bots: Array<{ id: string; name: string; url?: string }>,
  maxRows: number = MAX_SOURCES_IN_REPORT
): string {
  if (!domains || domains.length === 0) {
    return '<tr><td colspan="5" class="text-center py-4 text-gray-500">No domains found</td></tr>';
  }

  // Sort by influence descending
  const sortedDomains = [...domains]
    .filter(d => d.influence !== undefined && d.influence !== null)
    .sort((a, b) => ((b.influence as number) || 0) - ((a.influence as number) || 0))
    .slice(0, maxRows);

  return sortedDomains.map((domain, index) => {
    const value = escapeHtml((domain.value || domain.code || '') as string);
    const linkTypeName = escapeHtml((domain.linkTypeName || '') as string);
    const influence = formatPercent(domain.influence as number);
    const influencePercent = ((domain.influence as number) || 0) * 100;
    const mentions = (domain.mentions as number) || 0;
    const mentionsAsPercent = (domain.mentionsAsPercent as number) || 0;
    const position = domain.appearanceOrder !== undefined
      ? `${Math.round(domain.appearanceOrder as number)}`
      : 'N/A';

    // Get trend values
    const influenceTrend = getTrendIcon(domain.influenceTrend as number | undefined);
    const positionTrend = getTrendIcon(domain.appearanceOrderTrend as number | undefined);
    const mentionsTrend = getTrendIcon(domain.mentionsTrend as number | undefined);

    // Get bots that cited this domain
    const domainBots = domain.bots
      ? (domain.bots as string).split(',').map(b => b.trim()).filter(Boolean)
      : [];

    // Link to source page
    const sourcePageUrl = `website/${slugify(value)}.html`;

    // Favicon
    const faviconHtml = `<img src="https://www.google.com/s2/favicons?domain=${value}&sz=32"
                             class="w-5 h-5 rounded flex-shrink-0"
                             alt=""
                             onerror="this.style.display='none'">`;

    const botDeckHtml = generateBotDeckHtml(domainBots, bots);

    return `
                        <tr ${getRowBotFilterAttributes(domainBots, bots)}>
                            <td>
                                <div class="flex items-center gap-2">
                                    ${faviconHtml}
                                    <a href="${sourcePageUrl}" class="font-medium hover:underline">${value}</a>
                                    ${linkTypeName ? `<span class="ml-1 px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">${linkTypeName}</span>` : ''}
                                </div>
                            </td>
                            <td class="text-center">
                                <div class="influence-gauge">
                                    <span class="text-sm font-medium">${influence}${influenceTrend}</span>
                                    <div class="influence-bar">
                                        <div class="influence-fill" style="width: ${Math.min(influencePercent * 2, 100)}%"></div>
                                    </div>
                                </div>
                            </td>
                            <td class="text-center">${position}${positionTrend}</td>
                            <td class="text-center">${mentions} (${formatPercent(mentionsAsPercent)})${mentionsTrend}</td>
                            <td>
                                <div class="flex items-center justify-center">
                                    ${botDeckHtml}
                                </div>
                            </td>
                        </tr>`;
  }).join('');
}

/**
 * Generate static HTML for individual link rows
 */
export function generateLinksTableHtml(
  links: Array<Record<string, unknown>>,
  bots: Array<{ id: string; name: string; url?: string }>,
  maxRows: number = MAX_LINKS_IN_REPORT
): string {
  if (!links || links.length === 0) {
    return '<tr><td colspan="5" class="text-center py-4 text-gray-500">No links found</td></tr>';
  }

  const sortedLinks = [...links]
    .filter(link => link.influence !== undefined && link.influence !== null)
    .sort((a, b) => ((b.influence as number) || 0) - ((a.influence as number) || 0))
    .slice(0, maxRows);

  return sortedLinks.map((linkItem, index) => {
    const valueRaw = (linkItem.value || linkItem.link || '') as string;
    const value = escapeHtml(valueRaw);
    const displayValue = escapeHtml(truncateMiddle(valueRaw));
    const href = makeClickableUrl((linkItem.link || valueRaw) as string);
    const domain = extractDomain(href) || valueRaw.split('/')[0];
    const influence = formatPercent(linkItem.influence as number);
    const influencePercent = ((linkItem.influence as number) || 0) * 100;
    const mentions = (linkItem.mentions as number) || 0;
    const mentionsAsPercent = (linkItem.mentionsAsPercent as number) || 0;
    const position = linkItem.appearanceOrder !== undefined
      ? `${Math.round(linkItem.appearanceOrder as number)}`
      : 'N/A';

    const influenceTrend = getTrendIcon(linkItem.influenceTrend as number | undefined);
    const positionTrend = getTrendIcon(linkItem.appearanceOrderTrend as number | undefined);
    const mentionsTrend = getTrendIcon(linkItem.mentionsTrend as number | undefined);
    const linkBots = linkItem.bots
      ? (linkItem.bots as string).split(',').map(b => b.trim()).filter(Boolean)
      : [];
    const botDeckHtml = generateBotDeckHtml(linkBots, bots);

    const faviconHtml = domain
      ? `<img src="https://www.google.com/s2/favicons?domain=${escapeHtml(domain)}&sz=32"
             class="w-5 h-5 rounded flex-shrink-0"
             alt=""
             onerror="this.style.display='none'">`
      : '';

    return `
                        <tr ${getRowBotFilterAttributes(linkBots, bots)}>
                            <td data-export-value="${value}">
                                <div class="flex items-center gap-2">
                                    ${faviconHtml}
                                    <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="font-medium hover:underline table-link-label" title="${value}">${displayValue}</a>
                                </div>
                            </td>
                            <td class="text-center">
                                <div class="influence-gauge">
                                    <span class="text-sm font-medium">${influence}${influenceTrend}</span>
                                    <div class="influence-bar">
                                        <div class="influence-fill" style="width: ${Math.min(influencePercent * 2, 100)}%"></div>
                                    </div>
                                </div>
                            </td>
                            <td class="text-center">${position}${positionTrend}</td>
                            <td class="text-center">${mentions} (${formatPercent(mentionsAsPercent)})${mentionsTrend}</td>
                            <td>
                                <div class="flex items-center justify-center">
                                    ${botDeckHtml}
                                </div>
                            </td>
                        </tr>`;
  }).join('');
}

/**
 * Generate static HTML for questions list (aggregate report only)
 */
export function generateQuestionsListHtml(
  questions: Array<{ id: string; text: string; brandsCount?: number; domainsCount?: number }>,
  isAggregate: boolean = true
): string {
  if (!isAggregate || !questions || questions.length === 0) {
    return '';
  }

  const questionsHtml = questions.map((q, index) => {
    const questionUrl = `${q.id}/index.html`;
    return `
                    <a href="${questionUrl}"
                       class="block p-4 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-indigo-500 dark:hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all">
                        <div class="flex items-start gap-3">
                            <span class="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-semibold text-sm">
                                ${index + 1}
                            </span>
                            <div class="flex-1 min-w-0">
                                <p class="text-gray-900 dark:text-white font-medium line-clamp-2">${escapeHtml(q.text)}</p>
                                <div class="flex items-center gap-4 mt-2 text-xs text-gray-500 dark:text-gray-400">
                                    ${q.brandsCount ? `<span><i class="fas fa-building mr-1"></i>${q.brandsCount} mentions</span>` : ''}
                                    ${q.domainsCount ? `<span><i class="fas fa-globe mr-1"></i>${q.domainsCount} domains</span>` : ''}
                                </div>
                            </div>
                            <i class="fas fa-chevron-right text-gray-400 flex-shrink-0"></i>
                        </div>
                    </a>`;
  }).join('');

  return `
        <section class="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-8">
            <div class="section-header">
                <i class="fas fa-list-ol text-xl"></i>
                <h2>Per-Question Reports</h2>
            </div>
            <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
                View detailed rankings for each individual question
            </p>
            <div class="grid gap-3 md:grid-cols-2">
${questionsHtml}
            </div>
        </section>`;
}

/**
 * Generate questions header HTML for aggregate reports
 * Returns compact indicator for header + modal popup for full list
 */
function generateQuestionsHeaderHtml(
  questions: Array<{ id: string; text: string }>,
  isAggregate: boolean
): { indicator: string; modal: string } {
  // Per-question: question already in REPORT_TITLE, return empty
  if (!isAggregate || !questions || questions.length === 0) {
    return { indicator: '', modal: '' };
  }

  const questionCount = questions.length;

  // Compact indicator for header (white text for gradient background)
  // No clickable button here - the metric card handles opening the modal
  const indicator = `
            <div class="mt-3 inline-flex items-center gap-2 bg-white/10 rounded-lg px-3 py-2">
                <i class="fas fa-question-circle text-white/70"></i>
                <span class="text-white/80 text-sm">
                    ${questionCount} question${questionCount !== 1 ? 's' : ''} analyzed
                </span>
            </div>`;

  // Modal popup with full questions list including "view report" links
  const questionsListHtml = questions.map((q, index) => `
                        <li class="text-gray-700 dark:text-gray-300 py-2 flex justify-between items-start gap-4">
                            <span>${index + 1}. ${escapeHtml(q.text)}</span>
                            <a href="${q.id}/index.html" class="text-indigo-500 hover:underline text-sm whitespace-nowrap flex-shrink-0">view report</a>
                        </li>`
  ).join('');

  const modal = `
    <div id="questions-modal" class="questions-modal-overlay">
        <div class="questions-modal">
            <div class="questions-modal-header">
                <h3 class="font-semibold text-lg text-gray-900 dark:text-white">
                    <i class="fas fa-question-circle mr-2 text-indigo-500"></i>
                    Questions Analyzed
                </h3>
                <button class="questions-modal-close" onclick="closeQuestionsModal()" aria-label="Close">&times;</button>
            </div>
            <div class="questions-modal-body">
                <ol class="space-y-2 list-none">${questionsListHtml}
                </ol>
            </div>
        </div>
    </div>`;

  return { indicator, modal };
}

/**
 * Generate report header HTML
 * Different layouts for aggregate vs per-question reports
 * - Aggregate: Project name + "AI mentions in answers to N questions"
 * - Per-question: Project name + "AI mentions in answer for 1 question: {question}"
 */
function generateReportHeaderHtml(config: {
  projectName: string;
  reportTitle: string;
  reportDate: string;
  isAggregate: boolean;
  questionsCount: number;
}): string {
  const { projectName, reportTitle, reportDate, isAggregate, questionsCount } = config;
  const displayDate = formatDateHeader(reportDate);

  if (isAggregate) {
    // Aggregate: Project name + "AI mentions in answers to N questions"
    return `
                <div class="flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <h1 class="text-xl md:text-2xl font-black">${escapeHtml(projectName)}</h1>
                        <p class="text-white/80 text-sm mt-1">
                            AI mentions in answers to <strong>${questionsCount}</strong> question${questionsCount !== 1 ? 's' : ''}
                        </p>
                    </div>
                    <p class="text-white/80 text-sm">
                        <i class="fas fa-calendar-alt mr-1"></i>${displayDate}
                    </p>
                </div>`;
  } else {
    // Per-question: Project name + "AI mentions in answer for 1 question: {question}"
    return `
                <div>
                    <h1 class="text-xl md:text-2xl font-black">${escapeHtml(projectName)}</h1>
                    <p class="text-white/80 text-sm mt-2 leading-relaxed">
                        AI mentions in answer for 1 question:
                        <span class="block mt-1 text-white font-medium">"${escapeHtml(reportTitle)}"</span>
                    </p>
                    <p class="text-white/60 text-xs mt-2">
                        <i class="fas fa-calendar-alt mr-1"></i>${displayDate}
                    </p>
                </div>`;
  }
}

/**
 * Generate question links footer for per-question reports
 * Shows link to aggregate report and all questions (including current)
 */
export function generateQuestionLinksFooterHtml(
  questions: Array<{ id: string; text: string }>,
  isAggregate: boolean,
  currentQuestionId?: string
): string {
  // Only show for per-question reports
  if (isAggregate || !questions || questions.length === 0) {
    return '';
  }

  // List ALL questions (including current)
  const questionsLinksHtml = questions.map((q, index) => {
    const questionUrl = `../${q.id}/index.html`;
    const isCurrent = q.id === currentQuestionId;
    const shortText = q.text.length > 80 ? q.text.substring(0, 80) + '...' : q.text;

    // Highlight current question
    const classes = isCurrent
      ? 'font-medium text-gray-900 dark:text-white'
      : 'text-gray-600 dark:text-gray-400 hover:underline';
    const marker = isCurrent ? ' <span class="text-xs text-indigo-500">(current)</span>' : '';

    return `<a href="${questionUrl}" class="block py-2 ${classes}">
                <span class="text-gray-400 mr-2">${index + 1}.</span>
                ${escapeHtml(shortText)}${marker}
            </a>`;
  }).join('');

  return `
        <section class="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-6 mb-8 border border-gray-200 dark:border-gray-700">
            <h3 class="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-4">
                <i class="fas fa-folder-open mr-2"></i>More Reports
            </h3>

            <!-- Aggregate Report Link -->
            <a href="../index.html"
               class="inline-flex items-center gap-2 px-4 py-2 mb-4 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
                <i class="fas fa-chart-pie"></i>
                View Aggregate Report (All ${questions.length} Questions)
            </a>

            <!-- Individual Questions List -->
            <div class="mt-4">
                <h4 class="text-sm font-medium text-gray-600 dark:text-gray-400 mb-2">
                    Individual Question Reports:
                </h4>
                <div class="space-y-1">
                    ${questionsLinksHtml}
                </div>
            </div>
        </section>`;
}

/**
 * Build JSON-LD structured data for main report
 * Enhanced with FAQPage and ItemList schemas for SEO
 */
function buildJsonLd(
  meta: {
    canonicalUrl: string;
    projectName: string;
    reportDate: string;
    reportTitle: string;
    brandsCount: number;
    botsCount: number;
    domainsCount: number;
    botNames: string[];
    topBrandsList: string;
    questionsList: string;
    formattedDate: string;
    baseUrl?: string;  // Base URL for absolute URLs (e.g., https://aicw.io/ranking/Project/questionId/)
  },
  seoData?: {
    faqs?: Array<{ question: string; answer: string }>;
    topBrands?: Array<{ value: string; type?: string }>;
  }
): string {
  // Build rich description for Dataset (plain text, no HTML)
  const botNamesText = meta.botNames.slice(0, 5).join(', ') + (meta.botNames.length > 5 ? ', and more' : '');
  const richDescription = `This report was generated for entity mentions and citations about ${meta.projectName} in answers from ${meta.botsCount} AI models (namely: ${botNamesText}). AI models were asked the following questions: ${meta.questionsList}. ${meta.brandsCount} mentions and ${meta.domainsCount} link domains were detected. Top mentions detected are: ${meta.topBrandsList}. This report was generated on ${meta.formattedDate} by AICW AI Mentions.`;

  // Build absolute URL for the report (for breadcrumbs)
  const absoluteReportUrl = meta.baseUrl
    ? `${meta.baseUrl}index.html`
    : (meta.canonicalUrl || 'index.html');
  // Build absolute URL for the project listing page (parent of report)
  // For aicw.io hosted reports, this should be https://aicw.io/ranking/
  const absoluteProjectUrl = meta.baseUrl
    ? meta.baseUrl.replace(/\/[^/]+\/$/, '/')
    : 'https://aicw.io/ranking/';

  const graph: object[] = [
    {
      "@type": "WebPage",
      "@id": `${meta.canonicalUrl}#webpage`,
      "url": meta.canonicalUrl,
      "name": `${meta.reportTitle} | AICW AI Mentions`,
      "description": `AI mentions report: ${meta.brandsCount} entities mentioned across ${meta.botsCount} AI models.`,
      "datePublished": meta.reportDate,
      "isPartOf": {
        "@type": "WebSite",
        "name": "AICW AI Mentions",
        "url": "https://aicw.io"
      }
    },
    {
      "@type": "Report",
      "name": `${meta.projectName} AI Mentions Report`,
      "description": richDescription,
      "datePublished": meta.reportDate,
      "reportNumber": meta.reportDate.replace(/-/g, ''),
      "author": {
        "@type": "Organization",
        "name": "AICW AI Mentions",
        "url": "https://aicw.io"
      }
    },
    {
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "AICW AI Mentions", "item": "https://aicw.io" },
        { "@type": "ListItem", "position": 2, "name": meta.projectName, "item": absoluteProjectUrl },
        { "@type": "ListItem", "position": 3, "name": "Report", "item": absoluteReportUrl }
      ]
    }
  ];

  // Add FAQPage schema if FAQs provided
  if (seoData?.faqs && seoData.faqs.length > 0) {
    graph.push(buildFaqJsonLd(seoData.faqs));
  }

  // Add ItemList schema for brand rankings if brands provided
  if (seoData?.topBrands && seoData.topBrands.length > 0) {
    graph.push(buildItemListJsonLd(seoData.topBrands, `Top AI Mentions - ${meta.projectName}`));
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": graph
  };

  return JSON.stringify(jsonLd, null, 2);
}

/**
 * Configuration for static report generation
 */
export interface StaticReportConfig {
  project: string;
  questionId?: string;  // undefined for aggregate
  targetDate: string;
  outputDir: string;
  templateDir: string;
  enrichedDataFile: string;
  isAggregate?: boolean;
  questions?: Array<{ id: string; text: string; brandsCount?: number; domainsCount?: number }>;
  questionText?: string;
  canonicalUrl?: string;
  baseUrl?: string;  // Base URL for absolute URLs in JSON-LD (e.g., https://aicw.io/ranking/Project/questionId/)
}

/**
 * Generate static main report page
 */
export async function generateStaticMainPage(config: StaticReportConfig): Promise<boolean> {
  const {
    project,
    questionId,
    targetDate,
    outputDir,
    templateDir,
    enrichedDataFile,
    isAggregate = false,
    questions = [],
    questionText,
    canonicalUrl = '',
    baseUrl
  } = config;

  try {
    // Load data from enriched data file
    const loadResult = await loadDataJs(enrichedDataFile);
    if (!loadResult || !loadResult.data) {
      logger.warn(`No data found in ${enrichedDataFile}`);
      return false;
    }
    const data = loadResult.data;

    // Extract data arrays
    const brands = (data.brands || []) as Array<Record<string, unknown>>;
    const linkDomains = (data.linkDomains || []) as Array<Record<string, unknown>>;
    const links = (data.links || []) as Array<Record<string, unknown>>;
    const allBots = (data.bots || []) as Array<{ id: string; name: string; url?: string }>;

    // Filter bots to only those that have actual mentions in the data
    // (data.bots contains all models from preset, but not all may have been used)
    const bots = allBots.filter(bot => {
      return brands.some(b => {
        const mentions = b.mentionsByModel as Record<string, number> | undefined;
        return mentions && mentions[bot.id] && mentions[bot.id] > 0;
      });
    });

    // Count metrics
    const brandsCount = brands.length;
    const domainsCount = linkDomains.length;
    const questionsCount = isAggregate ? questions.length : 1;
    const botsCount = bots.length;

    // Report title
    const reportTitle = isAggregate
      ? (questionsCount > 1 ? `${project} - Aggregate Report` : `${project} - AI Mentions Report`)
      : (questionText || `${project} - AI Mentions Report`);

    // Read template
    const templatePath = path.join(templateDir, 'index-static.html');
    let template: string;
    try {
      template = await fs.readFile(templatePath, 'utf-8');
    } catch (err) {
      logger.error(`Failed to read static template: ${templatePath}`);
      return false;
    }

    // Load custom footer code
    const customFooterCode = await loadCustomFooterCode('index-project');

    // Extract top brands sorted by influence for SEO content
    const sortedBrands = [...brands]
      .filter(b => b.influence !== undefined && b.influence !== null)
      .sort((a, b) => ((b.influence as number) || 0) - ((a.influence as number) || 0));

    const topBrands = sortedBrands.slice(0, 10).map(b => ({
      value: (b.value || b.code || '') as string,
      type: (b.type || 'brand') as string,
      influence: (b.influence as number) || 0,
      link: (b.link || '') as string  // Use .link (brand website), NOT .sources (citation URLs)
    }));

    // Extract bot names for SEO content
    const botNames = bots.map(b => b.name);

    // Generate static HTML sections
    const metricsHtml = generateMetricsHtml(brandsCount, domainsCount, questionsCount, botsCount, isAggregate);
    const brandsTableHtml = generateBrandsTableHtml(brands, bots, MAX_BRANDS_IN_REPORT);
    const domainsTableHtml = generateDomainsTableHtml(linkDomains, bots, MAX_SOURCES_IN_REPORT);
    const linksTableHtml = generateLinksTableHtml(links, bots, MAX_LINKS_IN_REPORT);
    const questionsListHtml = generateQuestionsListHtml(questions, isAggregate);
    const questionLinksFooterHtml = generateQuestionLinksFooterHtml(questions, isAggregate, questionId);
    const questionsHeaderHtml = generateQuestionsHeaderHtml(questions, isAggregate);
    const reportHeaderHtml = generateReportHeaderHtml({
      projectName: project,
      reportTitle,
      reportDate: targetDate,
      isAggregate,
      questionsCount,
    });

    // Prepare questions for SEO content (with simplified structure)
    const questionsForSeo = questions.map(q => ({ id: q.id, text: q.text }));

    // Generate SEO sections: Introduction and FAQ
    const introHtml = generateReportIntroHtml({
      projectName: project,
      reportDate: targetDate,
      brandsCount,
      domainsCount,
      questionsCount,
      bots,
      topBrands,
      questions: questionsForSeo,
      isAggregate,
      currentQuestionId: isAggregate ? undefined : questionId,
      basePath: isAggregate ? '' : '../'
    });

    const faqHtml = generateReportFaqHtml({
      projectName: project,
      botNames,
      botCount: botsCount,
      topBrands,
      questions: questionsForSeo,
      isAggregate,
      basePath: isAggregate ? '' : '../',
      brandsCount,
      domainsCount,
      bots
    });

    // Build FAQ data for JSON-LD (same questions as displayed, plain text format)
    const aiList = botNames.slice(0, 5).join(', ') + (botNames.length > 5 ? ', and more' : '');
    const top3Brands = topBrands.slice(0, 3).map(b => `${b.value} (${b.type})`).join(', ');
    const questionsListText = questionsForSeo.map((q, i) => `${i + 1}. "${q.text}"`).join('; ');
    const modelWeightsText = buildModelWeightsText(bots);
    const faqsForJsonLd = [
      {
        question: 'What is this AI Mentions Report about?',
        answer: `This report analyzes how AI chatbots like ${aiList} respond to questions related to ${project}. It identifies which brands, products, and organizations are mentioned most frequently and measures their share of voice in AI responses.`
      },
      ...(questionsForSeo.length > 0 ? [{
        question: 'What questions were analyzed in this report?',
        answer: `This report analyzed complete answers to ${questionsForSeo.length} question${questionsForSeo.length !== 1 ? 's' : ''}: ${questionsListText}.`
      }] : []),
      {
        question: 'How many brands were analyzed in this report?',
        answer: `This report analyzed ${brandsCount} unique brand${brandsCount !== 1 ? 's' : ''} mentioned across ${botsCount} AI models.`
      },
      {
        question: 'How many link domains were detected?',
        answer: `AI models cited ${domainsCount} unique link domain${domainsCount !== 1 ? 's' : ''} when answering questions.`
      },
      {
        question: 'Which brands are mentioned most by AI models?',
        answer: topBrands.length >= 3
          ? `The top 3 most mentioned brands are ${top3Brands}, based on analysis of ${botsCount} AI model responses.`
          : `This report analyzes brand mentions across ${botsCount} AI models. View the rankings table for complete details.`
      },
      {
        question: 'How many AI models were analyzed?',
        answer: `This report analyzed responses from ${botsCount} AI models: ${aiList}.`
      },
      {
        question: 'What does "Share of Voice" mean and how is it calculated?',
        answer: `Share of Voice (Voice %) measures brand prominence across AI models. Formula: Share of Voice = Model Coverage × Quality Score. Where: Model Coverage = Sum of normalized weights for models mentioning the brand; Quality Score = Prominence / Max Prominence in dataset; Prominence = Mentions × (1 / log2(Position + 1)). Model weights (based on Monthly Active Users): ${modelWeightsText}. Brands appearing in top positions across high-traffic models achieve higher Share of Voice.`
      }
    ];

    // Build data for rich JSON-LD description
    const topBrandsListForJsonLd = topBrands.slice(0, 5).map(b => `${b.value} (${formatPercent(b.influence)})`).join(', ');
    const questionsListForJsonLd = questionsForSeo.map(q => `"${q.text}"`).join(', ');
    const formattedDateForJsonLd = formatDateHuman(targetDate);
    const reportQuestionsJson = JSON.stringify(questionsForSeo);

    // Generate JSON-LD with FAQ and ItemList
    const jsonLd = buildJsonLd({
      canonicalUrl,
      projectName: project,
      reportDate: targetDate,
      reportTitle,
      brandsCount,
      botsCount,
      domainsCount,
      botNames,
      topBrandsList: topBrandsListForJsonLd,
      questionsList: questionsListForJsonLd,
      formattedDate: formattedDateForJsonLd,
      baseUrl
    }, {
      faqs: [],
      topBrands
    });

    // Create URL-safe slug for UTM parameters
    const projectSlug = project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Replace macros
    const replacements: Record<string, string> = {
      '{{REPORT_TITLE}}': escapeHtml(reportTitle),
      '{{PROJECT_NAME}}': escapeHtml(project),
      '{{PROJECT_NAME_SLUG}}': projectSlug,
      '{{REPORT_DATE}}': targetDate,
      '{{REPORT_DATE_ISO}}': targetDate,
      '{{REPORT_DATE_WITHOUT_DASHES}}': targetDate.replace(/-/g, ''),
      '{{REPORT_CREATED_AT_DATETIME}}': getCurrentDateTimeAsStringISO(),
      '{{REPORT_ENGINE_VERSION}}': getCurrentVersion(),
      '{{ENTITY_COUNT}}': brandsCount.toString(),
      '{{BOT_COUNT}}': botsCount.toString(),
      '{{CANONICAL_URL}}': canonicalUrl,
      '{{JSON_LD_DATA}}': jsonLd,
      '{{STATIC_METRICS_HTML}}': metricsHtml,
      '{{STATIC_BRANDS_TABLE_HTML}}': brandsTableHtml,
      '{{STATIC_DOMAINS_TABLE_HTML}}': domainsTableHtml,
      '{{STATIC_LINKS_TABLE_HTML}}': linksTableHtml,
      '{{STATIC_QUESTIONS_LIST_HTML}}': questionsListHtml,
      '{{STATIC_QUESTION_LINKS_FOOTER_HTML}}': questionLinksFooterHtml,
      '{{STATIC_QUESTIONS_HEADER_HTML}}': questionsHeaderHtml.indicator,
      '{{STATIC_QUESTIONS_MODAL_HTML}}': questionsHeaderHtml.modal,
      '{{STATIC_REPORT_HEADER_HTML}}': reportHeaderHtml,
      '{{STATIC_INTRO_HTML}}': introHtml,
      '{{STATIC_FAQ_HTML}}': faqHtml,
      '{{REPORT_QUESTIONS_JSON}}': reportQuestionsJson,
      '{{FOOTER_CUSTOM_CODE}}': customFooterCode
    };

    let html = template;
    for (const [macro, value] of Object.entries(replacements)) {
      html = html.replace(new RegExp(macro.replace(/[{}]/g, '\\$&'), 'g'), value);
    }

    // Write output file
    const outputPath = path.join(outputDir, 'index.html');
    await writeFileAtomic(outputPath, html);

    // Write report metadata for navigation (used by reports index page)
    const reportMeta = {
      brands: brandsCount,
      sources: domainsCount,
      domains: domainsCount,
      questions: questionsCount,
      bots: botsCount,
      generated: new Date().toISOString()
    };
    await writeFileAtomic(path.join(outputDir, 'report-meta.json'), JSON.stringify(reportMeta));

    logger.debug(`Generated static main report: ${outputPath}`);
    return true;
  } catch (err) {
    logger.error(`Failed to generate static main page: ${err}`);
    return false;
  }
}

/**
 * Generate static reports for a project (aggregate + per-question)
 */
export async function generateStaticReports(config: {
  project: string;
  targetDate: string;
  outputBaseDir: string;
  templateDir: string;
  questionDirs: string[];
  aggregateDataFile: string;
  getQuestionDataFile: (questionId: string) => string;
  getQuestionText: (questionId: string) => string;
}): Promise<{ success: number; failed: number }> {
  const {
    project,
    targetDate,
    outputBaseDir,
    templateDir,
    questionDirs,
    aggregateDataFile,
    getQuestionDataFile,
    getQuestionText
  } = config;

  let success = 0;
  let failed = 0;

  // Build questions list for aggregate report
  const questions: Array<{ id: string; text: string; brandsCount?: number; domainsCount?: number }> = [];

  for (const questionId of questionDirs) {
    const questionText = getQuestionText(questionId);
    const dataFile = getQuestionDataFile(questionId);

    try {
      const loadResult = await loadDataJs(dataFile);
      const data = loadResult?.data;
      questions.push({
        id: questionId,
        text: questionText,
        brandsCount: (data?.brands as Array<unknown>)?.length || 0,
        domainsCount: (data?.linkDomains as Array<unknown>)?.length || 0
      });
    } catch {
      questions.push({
        id: questionId,
        text: questionText
      });
    }
  }

  // Generate aggregate report
  const aggregateResult = await generateStaticMainPage({
    project,
    targetDate,
    outputDir: outputBaseDir,
    templateDir,
    enrichedDataFile: aggregateDataFile,
    isAggregate: true,
    questions
  });

  if (aggregateResult) {
    success++;
    logger.info(`Generated aggregate static report`);
  } else {
    failed++;
    logger.warn(`Failed to generate aggregate static report`);
  }

  // Generate per-question reports
  for (const questionId of questionDirs) {
    const questionOutputDir = path.join(outputBaseDir, questionId);
    const dataFile = getQuestionDataFile(questionId);
    const questionText = getQuestionText(questionId);

    const result = await generateStaticMainPage({
      project,
      questionId,
      targetDate,
      outputDir: questionOutputDir,
      templateDir,
      enrichedDataFile: dataFile,
      isAggregate: false,
      questionText
    });

    if (result) {
      success++;
    } else {
      failed++;
    }
  }

  return { success, failed };
}
