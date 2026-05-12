# AICW AI Mentions

Open-source CLI for checking how AI assistants mention a company, product, person, or topic.

It asks multiple AI models the same questions, extracts mentions and cited links, then builds a local HTML report with:

- mention rankings
- cited links
- link domains
- model filters, search, and CSV export

## Video Demo

https://github.com/user-attachments/assets/4e334850-e496-40fd-9204-dc37fb534489

## Screenshots

### Mentions

![AICW AI Mentions report showing mention rankings](docs/imgs/mentions.png)

### Links

![AICW AI Mentions report showing cited links](docs/imgs/links.png)

### Link Domains

![AICW AI Mentions report showing link domains](docs/imgs/link-domains.png)

### Live Demo report

[Explore live demo report for "Y Combinator" term](https://aicw.io/demo/aicw-ai-mentions/)

## Install

Run without a global install:

```bash
npx aicw-ai-mentions@latest setup-api-key
npx aicw-ai-mentions@latest scan "Y Combinator"
npx aicw-ai-mentions@latest serve
```

Or install globally:

```bash
npm install -g aicw-ai-mentions
aicw-ai-mentions setup-api-key
aicw-ai-mentions scan "Y Combinator"
aicw-ai-mentions serve
```

Then open the local report URL printed by `serve`.

By default, `scan` runs every question from the built-in [default question template](src/config/data/templates/questions/default.md). You can also pass your own line-based Markdown template file:

```bash
aicw-ai-mentions scan "Y Combinator" --template ./questions.md
```

Or pass a template string directly:

```bash
aicw-ai-mentions scan "Y Combinator" --template-text "Who mentions {{SUBJECT}}?\\nWhich links cite {{SUBJECT}}?"
```

Each non-empty, non-comment line is treated as one question; `-`, `*`, and numbered list prefixes are accepted. Use `{{SUBJECT}}` where the scan subject should appear. By default, every question in the template runs; use `--questions 2` only when you intentionally want the first two questions.

## Requirements

- Node.js 18+
- An OpenRouter API key

The bundled OSS model presets use OpenRouter by default because one key can route requests to multiple AI assistants. You can provide the key with:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

or run:

```bash
aicw-ai-mentions setup-api-key
```

`setup-api-key` stores the key in your local AICW data folder. You can also put `OPENROUTER_API_KEY` in `.env.local` or `.env`.

## Example Scan

The package does not ship a generated demo report. To create your own local report, run:

```bash
aicw-ai-mentions scan "Y Combinator"
aicw-ai-mentions serve
```

`scan` stores local project data and generated reports in your AICW data folder. `serve` prints the local report URL.

## Local Data

Reports, logs, cache files, and saved credentials stay on your machine.

To print the exact data folder on your machine:

```bash
aicw-ai-mentions show-user-data-location
```

Default data folders:

- macOS: `~/Library/Application Support/aicw/`
- Windows: `%APPDATA%\aicw\`
- Linux: `~/.config/aicw/`

Link verification is optional and off by default. Update checks only show a notice when a newer npm version exists; they do not install anything automatically.

## Development

```bash
git clone https://github.com/aicw-io/aicw-ai-mentions.git
cd aicw-ai-mentions
npm install
npm test
npm run build
```

Useful local commands:

```bash
npm run demo:build
npm run package:dry
node bin/aicw-ai-mentions.js help
```

`npm run demo:build` is a maintainer helper. It writes generated demo output to `.demo-data/`, which is local-only and not included in the npm package.

## License

See [LICENSE](LICENSE).
