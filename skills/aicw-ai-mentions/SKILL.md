---
name: aicw-ai-mentions
description: Run AICW AI Mentions perception scans and inspect reports through MCP tools. Use for AI visibility, brand mentions, citations, and report analysis.
---

# AICW AI Mentions

Use this skill when the user wants to measure how AI assistants mention a company, product, person, topic, or market, or when they want to inspect existing AICW AI Mentions reports.

## Required Tooling

Prefer the `aicw-ai-mentions` MCP server. The skill gives workflow guidance; MCP exposes the executable tools. If the MCP server is unavailable, tell the user to install/configure it before running scans.

Useful MCP tools:

- `aicw_openrouter_key_status`: check whether `OPENROUTER_API_KEY` is configured.
- `aicw_set_openrouter_api_key`: store an OpenRouter key in the encrypted local credentials file. Only call this when the user explicitly provides a key.
- `aicw_list_projects`: list saved scans.
- `aicw_get_project`: inspect questions and report metadata for one saved scan.
- `aicw_scan`: create questions, call AI models, analyze mentions/citations, and generate a local report.
- `aicw_rebuild_report`: rebuild a report from saved local data without calling AI models.

## Workflow

1. For existing reports, start with `aicw_list_projects`, then use `aicw_get_project` for the selected project.
2. Before a new scan, call `aicw_openrouter_key_status`. If no key is configured, ask the user for an OpenRouter API key or ask them to configure one outside the conversation.
3. For a new scan, call `aicw_scan` with a clear `subject`. Full scans call provider APIs and may take several minutes.
4. When the user wants custom questions, pass `templateText` to `aicw_scan` instead of relying on the default template.
5. To refresh HTML from existing data, use `aicw_rebuild_report` instead of running a new scan.

## Question Templates

Templates are line-based. Each non-empty line becomes one question. Use `{{SUBJECT}}` where the scan subject should appear.

Example `aicw_scan` arguments:

```json
{
  "subject": "Y Combinator",
  "templateText": "Which sources cite {{SUBJECT}} most often?\\nWhich competitors or alternatives are mentioned near {{SUBJECT}}?",
  "questions": 2
}
```

## Safety

Do not invent API keys or print a key back to the user. Do not expose the HTTP MCP endpoint through an untrusted tunnel, because the tools can run paid scans and store credentials. Prefer local stdio MCP for desktop agents.
