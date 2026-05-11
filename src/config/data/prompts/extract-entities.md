# THE INSTRUCTION TO STRICTLY FOLLOW WHEN GENERATING OUTPUT:

INSTRUCTION: Please generate the JS code content as output based on the following guidelines:

1. Start with the `output` object structure.
2. Include all necessary fields like report_question, report_date and others.
3. Strictly follow the instructions below which starts with the "INSTRUCTION:" keyword.
4. Format the output as valid JavaScript, with proper indentation.
5. Do not include any comments (i.e. /* */) in the output!

**CRITICAL: Your output must be RAW JavaScript code ONLY. Do NOT include any markdown formatting like ```javascript or ``` or any other code block markers. Start directly with the JavaScript code.**

Please generate the content following these guidelines, maintaining the overall structure and purpose of the output JS code without any starting ``` or ending ```.

START OF THE JS OUTPUT TEMPLATE:

output = {

/* INSTRUCTION: Extract brands from bot answers using COMPRESSED FORMAT.

Use short field names to minimize output:
- "v" = value (the entity name)
- "t" = type codes (comma-separated if multiple: 1=product, 2=organization, 3=person, 4=event)

GUIDELINES:
1. Use ONLY information from the `ANSWERS` section below
2. Only extract entities EXPLICITLY mentioned - do not infer
3. Use the most complete version of each name as mentioned in answers
4. Accuracy is crucial - if in doubt, omit

Do NOT include this instruction in the output!
*/

"brands": [
/* INSTRUCTION: Extract ALL significant named entities using compressed format.

## TYPE CODES:
- 1 = product (products, services, platforms, methodologies, standards, publications)
- 2 = organization (companies, institutions, agencies, associations, non-profits)
- 3 = person (executives, experts, authors, researchers, public figures)
- 4 = event (conferences, crises, awards, landmark cases, named occurrences)

## FORMAT: {"v":"EntityName","t":"TYPE_CODES"}

Use comma-separated type codes when entity has MULTIPLE types (primary type first):
- {"v":"Freshdesk","t":"2,1"}  → organization (primary) AND product
- {"v":"Zendesk","t":"2,1"}    → organization (primary) AND product
- {"v":"Slack","t":"2,1"}      → organization (primary) AND product
- {"v":"Google","t":"2"}       → organization only (products extracted separately)

## WHEN TO USE MULTIPLE TYPES:
- Company that IS its main product (same name): "Freshdesk", "Zendesk", "Slack", "Notion" → "2,1"
- Company with distinct product names: "Google" → "2", "Google Analytics" → "1" (separate entities)
- Person who is also a brand: Use "3" only (person type takes precedence)

## WHAT TYPE 1 (product) INCLUDES:
- Software/digital products (Salesforce, Notion, Bloomberg Terminal, Westlaw)
- Websites/platforms (Wikipedia, YouTube, LinkedIn, WebMD, Coursera)
- Physical products (iPhone, Tesla Model 3, Advil, Coca-Cola)
- Services (Netflix, Uber, Airbnb, McKinsey consulting)
- Publications/media (The New York Times, Nature, Harvard Business Review)
- Methodologies/frameworks (Agile, Six Sigma, Design Thinking, SWOT Analysis, Lean)
- Standards/certifications (ISO 9001, GDPR, HIPAA, PMP, CFA, SOC 2)
- Financial instruments (S&P 500, Bitcoin, Dow Jones)
- Medical/health products (Pfizer vaccine, Lipitor, CRISPR)

## WHAT TYPE 2 (organization) INCLUDES:
- Corporations (Google, Apple, Walmart, Toyota, Goldman Sachs, McKinsey)
- Healthcare orgs (Mayo Clinic, WHO, CDC, Johns Hopkins, Cleveland Clinic)
- Government/regulatory (FDA, EPA, SEC, Federal Reserve, EU Commission, UN)
- Educational (Harvard, MIT, Stanford, Oxford, UNESCO)
- Media (CNN, BBC, Reuters, Bloomberg, The Economist as org)
- Non-profits/NGOs (Red Cross, UNICEF, Greenpeace, Gates Foundation)
- Professional associations (AMA, ABA, IEEE, CFA Institute, PMI)
- Research institutions (RAND Corporation, Brookings, McKinsey Global Institute)

## WHAT TYPE 3 (person) INCLUDES:
- Business leaders (Warren Buffett, Elon Musk, Mary Barra)
- Healthcare/science experts (Anthony Fauci, any named researcher)
- Finance/economics (Janet Yellen, Ray Dalio)
- Authors/thought leaders (Malcolm Gladwell, Simon Sinek, Peter Drucker)
- Historical figures when relevant (Adam Smith, W. Edwards Deming)
- Use full names when available

## WHAT TYPE 4 (event) INCLUDES:
- Business events (Davos, TED, SXSW, industry trade shows)
- Financial events (2008 Financial Crisis, IPOs by name)
- Healthcare events (COVID-19 pandemic, clinical trials by name)
- Legal/political (Roe v. Wade, Dodd-Frank Act, landmark cases)
- Awards (Nobel Prize, Pulitzer Prize, industry awards)

## EXAMPLE OUTPUT (DO NOT use these in your output):
[
  {"v":"Zendesk","t":"2,1"},
  {"v":"Freshdesk","t":"2,1"},
  {"v":"Slack","t":"2,1"},
  {"v":"McKinsey","t":"2"},
  {"v":"Six Sigma","t":"1"},
  {"v":"Harvard Business Review","t":"1"},
  {"v":"Warren Buffett","t":"3"},
  {"v":"WHO","t":"2"},
  {"v":"ISO 9001","t":"1"},
  {"v":"Davos","t":"4"},
  {"v":"S&P 500","t":"1"}
]

## CRITICAL: Multi-Type vs Separate Entities

**USE MULTI-TYPE ("2,1")** when company name IS the product name:
- "Zendesk offers customer service..." → {"v":"Zendesk","t":"2,1"}
- "Freshdesk provides support tools..." → {"v":"Freshdesk","t":"2,1"}
- "Slack enables team communication..." → {"v":"Slack","t":"2,1"}

**USE SEPARATE ENTITIES** when product has a DIFFERENT name from company:
- "Zendesk QA offers AI-powered analysis..." →
  {"v":"Zendesk","t":"2,1"},     // Company (also a product)
  {"v":"Zendesk QA","t":"1"}     // Distinct product name

- "Microsoft's Azure provides cloud..." →
  {"v":"Microsoft","t":"2"},     // Company only
  {"v":"Azure","t":"1"}          // Product only

- "Google Analytics 4 provides tracking..." →
  {"v":"Google","t":"2"},        // Company only
  {"v":"Google Analytics 4","t":"1"} // Product only

- "OpenAI's ChatGPT offers AI chat..." →
  {"v":"OpenAI","t":"2"},        // Company only
  {"v":"ChatGPT","t":"1"}        // Product only

DO NOT only extract products - ALWAYS extract the parent organization too!

## EXTRACT:
- Named entities that can be searched or have identifiable presence
- Abbreviations for specific things (WHO, FDA, ISO, S&P, MIT, NATO)
- Publications/websites cited as sources
- Named methodologies/frameworks (Six Sigma, Agile, Design Thinking)
- Named standards/certifications (GDPR, HIPAA, ISO 9001)
- Both organization AND its products if both mentioned

## DO NOT EXTRACT:
- Generic concepts (strategy, innovation, best practices, leadership)
- Common nouns (company, framework, methodology, tool, platform, service)
- Vague references ("the company", "this study", "experts say", "leading firm")
- Generic industry terms (healthcare, finance, consulting, technology)
- Generic plural phrases ("Various tools", "Several platforms", "Multiple solutions")
- Names with domain extensions (use "AIclicks" not "AIclicks.io", use "Notion" not "notion.com")
- Incomplete or partial names (use complete brand names as written in answers)

Do NOT include this instruction in the output!
*/
]

}

# `ANSWERS` section:

Listed below are the answers from different AI models for the following question: `{{REPORT_QUESTION}}`.

Each bot's answer is in a separate `<answer model_id="...">...</answer>` section and looks like this:

<answer model_id="brave_search">
markdown text of the answer from brave_search will be here
</answer model_id="brave_search">

{{ANSWERS}}
