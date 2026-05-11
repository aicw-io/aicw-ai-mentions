

export const CRAWLER_BOT_CLASSIFICATION_TAGS = {
  AI_FOUNDATION_MODEL_TRAINING: 'AI_FOUNDATION_MODEL_TRAINING', // AI foundation model training
  AI_SEARCH_INDEX: 'AI_SEARCH_INDEX', // AI specific search index
  AI_USER_INTERACTION: 'AI_USER_INTERACTION', // AI specific user interaction
  NON_AI_SEARCH_RESULTS: 'SEARCH_RESULTS' // regular non-AI search index
} as const;

export interface AIProduct {
  readonly name: string;
  readonly url: string;
}

export const AI_PRODUCTS: Readonly<Record<string, AIProduct>> = {
  OPENAI_CHATGPT: { name: 'OpenAI ChatGPT', url: 'https://chatgpt.com' },
  ANTHROPIC_CLAUDE: { name: 'Anthropic Claude', url: 'https://claude.ai' },
  GOOGLE_GEMINI: { name: 'Google Gemini', url: 'https://gemini.google.com' },
  GOOGLE_AI_MODE: { name: 'Google AI Mode/AI Overviews', url: 'https://google.com' },
  BRAVE_SEARCH: { name: 'Brave Search', url: 'https://search.brave.com' },
  BING_SEARCH: { name: 'Bing Search', url: 'https://bing.com' },
  META_AI: { name: 'Meta AI', url: 'https://ai.meta.com' },
  PERPLEXITY_AI: { name: 'Perplexity AI', url: 'https://perplexity.ai' },
  GROK: { name: 'Grok AI', url: 'https://x.ai' },
  META_LLAMA: { name: 'Meta Llama (foundation LLM model)', url: 'https://llama.meta.com' },
  DEEPSEEK: { name: 'DeepSeek', url: 'https://deepseek.com' },
  DUCKDUCKGO: { name: 'DuckDuckGo', url: 'https://duckduckgo.com' }
};

export interface AIBotDefinition {
  /** Display name for reports */
  name: string;
  /** Full User-Agent string */
  user_agent: string;
  /** Optional description */
  description?: string;
  /** tags */
  tags?: string[];
  /** optional source url */
  related_ai_products?: string[];
  /** short identifier */
  identifier?: string;
}

const ALL_AI_PRODUCTS = Object.values(AI_PRODUCTS).map(p => p.name);

/**
 * List of AI bots to check against
 */
export const AI_USER_AGENTS: AIBotDefinition[] = [

  // BEGIN - Comomon Crawl bot https://commoncrawl.org/ccbot
  {
    name: 'CommonCrawl Dataset',
    identifier: 'CCBot',
    user_agent: 'CCBot/2.0 (+https://commoncrawl.org/bot.html)',
    description: 'Makes a copy of the Internet to Internet researchers, companies and individuals. This dataset is used by all leading AI companies for foundation model training.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_FOUNDATION_MODEL_TRAINING],
    related_ai_products: ALL_AI_PRODUCTS,
  },
  // END 
  // BEGIN - openai chatgpt bots https://platform.openai.com/docs/bots
  {
    name: 'ChatGPT Crawler',
    identifier: 'GPTBot',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot',
    description: 'It is used to crawl content that may be used in training our generative AI foundation models. Disallowing GPTBot indicates a site s content should not be used in training generative AI foundation models.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_FOUNDATION_MODEL_TRAINING],
    related_ai_products: [AI_PRODUCTS.OPENAI_CHATGPT.name],
  },
  {
    name: 'ChatGPT Internet Search Bot',
    identifier: 'OAI-SearchBot',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ; OAI-SearchBot/1.0; +https://openai.com/searchbot',
    description: 'used to link to and surface websites in search results in ChatGPT search features. It is not used to crawl content to train OpenAI s generative AI foundation models.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_SEARCH_INDEX],
    related_ai_products: [AI_PRODUCTS.OPENAI_CHATGPT.name],
  },
  {
    name: 'ChatGPT User Interaction Bot',
    identifier: 'ChatGPT-User',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    description: 'When users ask ChatGPT or a CustomGPT a question, it may visit a web page with a ChatGPT-User agent. ChatGPT users may also interact with external applications via GPT Actions. ChatGPT-User is not used for crawling the web in an automatic fashion, nor to crawl content for generative AI training.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_USER_INTERACTION],
    related_ai_products: [AI_PRODUCTS.OPENAI_CHATGPT.name],
  },
  // END 

  // BEGIN - Perplexity Crawlers https://docs.perplexity.ai/guides/bots
  {
    name: 'Perplexity Internet Search Bot',
    identifier: 'PerplexityBot',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    description: 'designed to surface and link websites in search results on Perplexity. It is not used to crawl content for AI foundation models.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_SEARCH_INDEX],
    related_ai_products: [AI_PRODUCTS.PERPLEXITY_AI.name],
  },
  {
    name: 'Perplexity User Interaction Bot',
    identifier: 'Perplexity-User',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
    description: 'When users ask Perplexity a question, it might visit a web page to help provide an accurate answer and include a link to the page in its response. ',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_USER_INTERACTION],
    related_ai_products: [AI_PRODUCTS.PERPLEXITY_AI.name],
  },  
  // END 

  // BEGIN - Anthropic Claude bots https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
  {
    name: 'Claude Foundation Model Training Bot',
    identifier: 'ClaudeBot',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    description: 'ClaudeBot helps enhance the utility and safety of our generative AI models by collecting web content that could potentially contribute to their training.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_FOUNDATION_MODEL_TRAINING],
    related_ai_products: [AI_PRODUCTS.ANTHROPIC_CLAUDE.name],
  },

  {
    name: 'Claude User Interaction Bot',
    identifier: 'Claude-User',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
    description: 'Claude-User supports Claude AI users. When individuals ask questions to Claude, it may access websites using a Claude-User agent.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_USER_INTERACTION],
    related_ai_products: [AI_PRODUCTS.ANTHROPIC_CLAUDE.name],
  },

  {
    name: 'Claude Internet Search Bot',
    identifier: 'Claude-SearchBot',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +searchbot@anthropic.com)',
    description: 'Claude-SearchBot navigates the web to improve search result quality for users. It analyzes online content specifically to enhance the relevance and accuracy of search responses.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_SEARCH_INDEX],
    related_ai_products: [AI_PRODUCTS.ANTHROPIC_CLAUDE.name],
  },

  // END

  // BEGIN - Google AI training crawler https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
  {
    name: 'Google Foundation Model Training Bot',
    identifier: 'Google-Extended',
    user_agent: 'Mozilla/5.0 (compatible; Google-Extended/1.0; +http://www.google.com/bot.html)',
    description: 'Google AI training crawler',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_FOUNDATION_MODEL_TRAINING],
    related_ai_products: [AI_PRODUCTS.GOOGLE_GEMINI.name, AI_PRODUCTS.GOOGLE_AI_MODE.name],
  },
  {
    name: 'Google Vertex AI Agents Bot',
    identifier: 'Google-CloudVertexBot',
    user_agent: 'Mozilla/5.0 (compatible; Google-CloudVertexBot/1.0; +http://www.google.com/bot.html)',
    description: 'Google Vertex AI Agents crawler. Used for crawls requested by site owners for building Vertex AI Agents. Does not affect Google Search or other products.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_FOUNDATION_MODEL_TRAINING],
    related_ai_products: [AI_PRODUCTS.GOOGLE_GEMINI.name, AI_PRODUCTS.GOOGLE_AI_MODE.name],
  },
  // END
  // BEGIN - Brave Search crawler https://brave.com/brave-search-crawl-bot/
  {
    name: 'Brave Search Crawler',
    identifier: 'Bravebot',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Bravebot/1.0; +https://search.brave.com/help/brave-search-crawler) Chrome/W.X.Y.Z Safari/537.36',
    description: 'Brave Search crawler, Brave Search results are powering Grok and other AIs for AI search results',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_SEARCH_INDEX],
    related_ai_products: [AI_PRODUCTS.BRAVE_SEARCH.name, AI_PRODUCTS.GROK.name],
  },
  // END 
  // BEGIN - Bing Search crawler https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0
  {
    name: 'Bing Search Crawler',
    identifier: 'Bingbot',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/W.X.Y.Z Safari/537.36',
    description: 'used by Bing to index web pages. Bing search is powering ChatGPT and other AI products.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_SEARCH_INDEX],
    related_ai_products: [AI_PRODUCTS.BING_SEARCH.name, AI_PRODUCTS.OPENAI_CHATGPT.name],
  },
  // END 
  // BEGIN - Meta user agents https://developers.facebook.com/docs/sharing/webmasters/web-crawlers/
  {
    name: 'Meta External Agent',
    identifier: 'Meta-ExternalAgent',
    user_agent: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    description: 'The Meta-ExternalAgent crawler crawls the web for use cases such as training AI models or improving products by indexing content directly.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_FOUNDATION_MODEL_TRAINING],
    related_ai_products: [AI_PRODUCTS.META_AI.name, AI_PRODUCTS.META_LLAMA.name],
  },
  {
    name: 'Meta Web Indexer',
    identifier: 'Meta-WebIndexer',
    user_agent: 'meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    description: 'navigates the web to improve Meta AI search result quality for users. In doing so, Meta analyzes online content to enhance the relevance and accuracy of Meta AI.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_SEARCH_INDEX],
    related_ai_products: [AI_PRODUCTS.META_AI.name],
  },
  {
    name: 'Meta External Hit',
    identifier: 'FacebookExternalHit',
    user_agent: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    description: 'used by Meta to access link shared by users.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_USER_INTERACTION],
    related_ai_products: [AI_PRODUCTS.META_AI.name],
  },
  {
    name: 'Meta External Fetcher',
    identifier: 'Meta-ExternalFetcher',
    user_agent: 'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    description: 'performs user-initiated fetches of individual links to support specific product functions. Because the fetch was initiated by a user, this crawler may bypass robots.txt rules.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_USER_INTERACTION],
    related_ai_products: [AI_PRODUCTS.META_AI.name],
  },
  // END 
  // BEGIN - DeepSeek https://github.com/ai-robots-txt/ai.robots.txt/blob/main/table-of-bot-metrics.md
  {
    name: 'Deepseek User Interaction Bot',
    identifier: 'Deepseek',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Deepseek/1.0; +https://www.deepseek.com)',
    description: 'primary user agent used by Deepseek when browsing the web.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_USER_INTERACTION],
    related_ai_products: [AI_PRODUCTS.DEEPSEEK.name],
  },   

  // END 
  // BEGIN - Mistral AI https://docs.mistral.ai/robots
  {
    name: 'MistralAI User Interaction Bot',
    identifier: 'MistralAI-User',
    user_agent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)',
    description: 'primary user agent used by Mistral when browsing the web.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_USER_INTERACTION],
    related_ai_products: [AI_PRODUCTS.META_LLAMA.name],
  },
  // END
  // BEGIN - DuckDuckGO https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot
  {
    name: 'DuckAssistBot User Interaction Bot',
    identifier: 'DuckAssistBot',
    user_agent: 'DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)',
    description: 'primary user agent used by DuckDuckGo for user interactions with AI.',
    tags: [CRAWLER_BOT_CLASSIFICATION_TAGS.AI_USER_INTERACTION],
    related_ai_products: [AI_PRODUCTS.DUCKDUCKGO.name],
  }
  // END
];

/**
 * Default browser User-Agent for baseline comparison
 * Updated to Chrome 131 (latest as of Nov 2024) to avoid detection as outdated browser
 */
export const DESKTOP_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const MOBILE_BROWSER_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export const DEFAULT_BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml',
  'Accept-Language': 'en-US,en'
} as const;

/**
 * Comprehensive browser headers for search engine checks to avoid CAPTCHA/blocking
 * Includes browser fingerprinting headers that real Chrome browsers send
 */
export const SEARCH_ENGINE_BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'max-age=0',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"'
} as const;
