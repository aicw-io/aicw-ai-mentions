import { spawn } from 'child_process';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { existsSync, promises as fs } from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  getPackageRoot,
  getUserProjectDir,
  getUserProjectOutputDir,
  getUserProjectQuestionsFile,
  USER_DATA_DIR,
  USER_CONFIG_CREDENTIALS_DIR,
  USER_CONFIG_CREDENTIALS_FILE,
  USER_PROJECTS_DIR,
  USER_REPORTS_DIR,
} from './config/user-paths.js';
import { createCredentialsFile, decryptCredentialsFile, isEncryptedCredentials } from './utils/crypto-utils.js';
import { getCurrentVersion } from './utils/update-checker.js';

type McpTransportName = 'stdio' | 'http';

interface McpOptions {
  transport: McpTransportName;
  host: string;
  port: number;
  path: string;
}

interface CliRunResult {
  ok: boolean;
  command: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_HTTP_PORT = 8787;
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_MCP_PATH = '/mcp';
const MAX_CAPTURE_BYTES = 250_000;
const MAX_RESPONSE_TEXT_LENGTH = 18_000;

function textResponse(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResponse(message: string, details?: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: message, details }, null, 2),
      },
    ],
  };
}

function appendLimited(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') <= MAX_CAPTURE_BYTES) {
    return next;
  }
  return next.slice(-MAX_CAPTURE_BYTES);
}

function truncateForTool(text: string): string {
  if (text.length <= MAX_RESPONSE_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, 4000)}\n\n[...truncated...]\n\n${text.slice(-12_000)}`;
}

function quoteArg(arg: string): string {
  return /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg;
}

function getCliEntrypoint(): string {
  return path.join(getPackageRoot(), 'bin', 'aicw-ai-mentions.js');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function loadStoredCredentials(): Promise<Record<string, string>> {
  const credentials: Record<string, string> = {};

  try {
    const content = await fs.readFile(USER_CONFIG_CREDENTIALS_FILE, 'utf8');
    const parsed = JSON.parse(content);
    if (isEncryptedCredentials(parsed)) {
      Object.assign(credentials, decryptCredentialsFile(parsed));
    }
  } catch {
    // Missing credentials are normal before setup.
  }

  return credentials;
}

async function saveStoredCredentials(credentials: Record<string, string>): Promise<void> {
  await fs.mkdir(USER_CONFIG_CREDENTIALS_DIR, { recursive: true });
  const encrypted = createCredentialsFile(credentials);
  await fs.writeFile(USER_CONFIG_CREDENTIALS_FILE, JSON.stringify(encrypted, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.chmod(USER_CONFIG_CREDENTIALS_FILE, 0o600);
}

function validateOpenRouterApiKey(apiKey: string): string | null {
  const value = apiKey.trim();
  if (value.length < 40) {
    return 'OpenRouter API keys are typically at least 40 characters.';
  }
  if (!value.startsWith('sk-')) {
    return 'OpenRouter API keys usually start with "sk-".';
  }
  if (/\s/.test(value)) {
    return 'API key should not contain whitespace.';
  }
  return null;
}

async function runCli(args: string[], timeoutSeconds: number): Promise<CliRunResult> {
  const cliPath = getCliEntrypoint();
  const command = [process.execPath, cliPath, ...args];
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICW_SKIP_UPDATE_CHECK: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGINT');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 5000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      settled = true;
      resolve({
        ok: false,
        command,
        exitCode: null,
        signal: null,
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + error.message,
        timedOut,
      });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      settled = true;
      resolve({
        ok: exitCode === 0 && !timedOut,
        command,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function cliResultResponse(result: CliRunResult, extra: Record<string, unknown> = {}) {
  const payload = {
    ok: result.ok,
    command: result.command.map(quoteArg).join(' '),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: truncateForTool(result.stdout.trim()),
    stderr: truncateForTool(result.stderr.trim()),
    dataDir: USER_DATA_DIR,
    ...extra,
  };

  return result.ok ? textResponse(payload) : errorResponse('aicw-ai-mentions command failed', payload);
}

async function listProjects(filter = '', limit = 50) {
  const projects: unknown[] = [];
  if (!existsSync(USER_PROJECTS_DIR)) {
    return { dataDir: USER_DATA_DIR, projects };
  }

  const normalizedFilter = filter.trim().toLowerCase();
  const entries = await fs.readdir(USER_PROJECTS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    if (normalizedFilter && !entry.name.toLowerCase().includes(normalizedFilter)) {
      continue;
    }

    const projectDir = path.join(USER_PROJECTS_DIR, entry.name);
    const reportDir = path.join(USER_REPORTS_DIR, entry.name);
    const config = await readJsonIfExists(path.join(projectDir, 'project.json'));
    const questionsDir = path.join(projectDir, 'questions');
    let questionCount = 0;

    try {
      const questionEntries = await fs.readdir(questionsDir, { withFileTypes: true });
      questionCount = questionEntries.filter((question) => question.isDirectory() && !question.name.startsWith('_')).length;
    } catch {
      questionCount = 0;
    }

    projects.push({
      name: entry.name,
      projectDir,
      reportDir,
      questionCount,
      hasReport: await pathExists(path.join(reportDir, 'index.html')),
      reportMeta: await readJsonIfExists(path.join(reportDir, 'report-meta.json')),
      config,
    });

    if (projects.length >= limit) {
      break;
    }
  }

  return { dataDir: USER_DATA_DIR, projects };
}

async function getProject(project: string) {
  const projectDir = getUserProjectDir(project);
  const reportDir = getUserProjectOutputDir(project);
  const questionsDir = path.join(projectDir, 'questions');
  const questionSummaries: unknown[] = [];

  try {
    const entries = await fs.readdir(questionsDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) {
        continue;
      }
      questionSummaries.push({
        id: entry.name,
        text: await readTextIfExists(path.join(questionsDir, entry.name, 'question.md')),
      });
    }
  } catch {
    // Missing questions are represented by an empty list.
  }

  return {
    name: project,
    projectDir,
    reportDir,
    config: await readJsonIfExists(path.join(projectDir, 'project.json')),
    questionsMarkdown: await readTextIfExists(getUserProjectQuestionsFile(project)),
    questions: questionSummaries,
    reportIndexPath: path.join(reportDir, 'index.html'),
    hasReport: await pathExists(path.join(reportDir, 'index.html')),
    reportMeta: await readJsonIfExists(path.join(reportDir, 'report-meta.json')),
  };
}

export function createAicwMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'aicw-ai-mentions',
      version: getCurrentVersion(),
    },
    {
      instructions:
        'Use these tools to inspect local AICW AI Mentions projects, run perception scans, and rebuild local HTML reports. Scan tools can call configured AI providers and may take several minutes.',
    }
  );

  server.registerTool(
    'aicw_openrouter_key_status',
    {
      title: 'Check OpenRouter key status',
      description: 'Report whether OPENROUTER_API_KEY is available from the environment or encrypted AICW credentials file.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const storedCredentials = await loadStoredCredentials();
      return textResponse({
        envConfigured: Boolean(process.env.OPENROUTER_API_KEY),
        storedConfigured: Boolean(storedCredentials.OPENROUTER_API_KEY),
        credentialsFile: USER_CONFIG_CREDENTIALS_FILE,
      });
    }
  );

  server.registerTool(
    'aicw_set_openrouter_api_key',
    {
      title: 'Set OpenRouter API key',
      description:
        'Store OPENROUTER_API_KEY in the encrypted local AICW credentials file. The key is not returned in the tool response.',
      inputSchema: z.object({
        apiKey: z.string().min(20).describe('OpenRouter API key to store locally.'),
        overwrite: z.boolean().default(true).describe('Replace an existing stored OpenRouter key.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ apiKey, overwrite }) => {
      const trimmedKey = apiKey.trim();
      const validationMessage = validateOpenRouterApiKey(trimmedKey);
      if (validationMessage) {
        return errorResponse(validationMessage);
      }

      const credentials = await loadStoredCredentials();
      if (credentials.OPENROUTER_API_KEY && !overwrite) {
        return textResponse({
          ok: true,
          changed: false,
          message: 'OPENROUTER_API_KEY is already configured and overwrite is false.',
          credentialsFile: USER_CONFIG_CREDENTIALS_FILE,
        });
      }

      credentials.OPENROUTER_API_KEY = trimmedKey;
      process.env.OPENROUTER_API_KEY = trimmedKey;
      await saveStoredCredentials(credentials);

      return textResponse({
        ok: true,
        changed: true,
        envKey: 'OPENROUTER_API_KEY',
        credentialsFile: USER_CONFIG_CREDENTIALS_FILE,
      });
    }
  );

  server.registerTool(
    'aicw_data_location',
    {
      title: 'Show AICW data location',
      description: 'Return the local data, projects, and reports folders used by aicw-ai-mentions.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      textResponse({
        dataDir: USER_DATA_DIR,
        projectsDir: USER_PROJECTS_DIR,
        reportsDir: USER_REPORTS_DIR,
      })
  );

  server.registerTool(
    'aicw_list_projects',
    {
      title: 'List AICW projects',
      description: 'List local AICW AI Mentions projects and basic report metadata.',
      inputSchema: z.object({
        filter: z.string().optional().describe('Optional case-insensitive substring filter for project names.'),
        limit: z.number().int().min(1).max(200).default(50).describe('Maximum number of projects to return.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ filter, limit }) => textResponse(await listProjects(filter, limit))
  );

  server.registerTool(
    'aicw_get_project',
    {
      title: 'Get AICW project details',
      description: 'Read a local project config, questions, and report metadata.',
      inputSchema: z.object({
        project: z.string().min(1).describe('Project name as stored in the AICW data folder.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project }) => textResponse(await getProject(project))
  );

  server.registerTool(
    'aicw_scan',
    {
      title: 'Run an AI mentions scan',
      description:
        'Create questions for a subject, ask configured AI models, analyze mentions, and generate a local report. This uses configured provider API keys and can take several minutes.',
      inputSchema: z.object({
        subject: z.string().min(1).describe('Company, product, person, topic, or market to scan.'),
        questions: z.number().int().min(1).max(20).optional().describe('Optional number of generated template questions to run.'),
        templateText: z
          .string()
          .optional()
          .describe('Optional line-based questions template. Use {{SUBJECT}} where the scan subject should appear.'),
        templatePath: z.string().optional().describe('Optional local Markdown template path readable by the MCP server process.'),
        timeoutSeconds: z.number().int().min(1).max(7200).default(1800).describe('Maximum time to wait for the CLI command.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ subject, questions, templateText, templatePath, timeoutSeconds }) => {
      const args = ['scan', subject];
      if (questions !== undefined) {
        args.push('--questions', String(questions));
      }
      if (templateText) {
        args.push('--template-text', templateText);
      }
      if (templatePath) {
        args.push('--template', templatePath);
      }

      const result = await runCli(args, timeoutSeconds);
      return cliResultResponse(result, {
        nextSteps: result.ok ? ['Run aicw-ai-mentions serve to view reports locally.', 'Use aicw_list_projects or aicw_get_project to inspect saved output.'] : [],
      });
    }
  );

  server.registerTool(
    'aicw_rebuild_report',
    {
      title: 'Rebuild an AI mentions report',
      description: 'Regenerate a local HTML report from existing saved answers and compiled data without asking AI models.',
      inputSchema: z.object({
        project: z.string().min(1).describe('Existing AICW project name.'),
        date: z.string().optional().describe('Optional target date in YYYY-MM-DD format.'),
        timeoutSeconds: z.number().int().min(1).max(3600).default(600).describe('Maximum time to wait for the CLI command.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project, date, timeoutSeconds }) => {
      const args = ['rebuild-report-only', project];
      if (date) {
        args.push('--date', date);
      }

      const result = await runCli(args, timeoutSeconds);
      return cliResultResponse(result, {
        project,
        reportDir: getUserProjectOutputDir(project),
      });
    }
  );

  return server;
}

function parseArgs(args: string[]): McpOptions {
  const options: McpOptions = {
    transport: 'stdio',
    host: DEFAULT_HTTP_HOST,
    port: DEFAULT_HTTP_PORT,
    path: DEFAULT_MCP_PATH,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--http') {
      options.transport = 'http';
      continue;
    }

    if (arg === '--stdio') {
      options.transport = 'stdio';
      continue;
    }

    if (arg === '--transport' && args[i + 1]) {
      const transport = args[++i];
      options.transport = transport === 'http' || transport === 'streamable-http' ? 'http' : 'stdio';
      continue;
    }

    if (arg.startsWith('--transport=')) {
      const transport = arg.slice('--transport='.length);
      options.transport = transport === 'http' || transport === 'streamable-http' ? 'http' : 'stdio';
      continue;
    }

    if (arg === '--port' && args[i + 1]) {
      options.port = Number.parseInt(args[++i], 10);
      continue;
    }

    if (arg.startsWith('--port=')) {
      options.port = Number.parseInt(arg.slice('--port='.length), 10);
      continue;
    }

    if (arg === '--host' && args[i + 1]) {
      options.host = args[++i];
      continue;
    }

    if (arg.startsWith('--host=')) {
      options.host = arg.slice('--host='.length);
      continue;
    }

    if (arg === '--path' && args[i + 1]) {
      options.path = normalizeMcpPath(args[++i]);
      continue;
    }

    if (arg.startsWith('--path=')) {
      options.path = normalizeMcpPath(arg.slice('--path='.length));
    }
  }

  if (!Number.isFinite(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error(`Invalid MCP HTTP port: ${options.port}`);
  }

  return options;
}

function normalizeMcpPath(value: string): string {
  if (!value) {
    return DEFAULT_MCP_PATH;
  }
  return value.startsWith('/') ? value : `/${value}`;
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

async function handleHttpMcpRequest(req: IncomingMessage, res: ServerResponse, mcpPath: string): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS' && url.pathname === mcpPath) {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('aicw-ai-mentions MCP server');
    return;
  }

  const isMcpMethod = req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE';
  if (url.pathname !== mcpPath || !isMcpMethod) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  setCorsHeaders(res);
  const server = createAicwMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

async function startHttpServer(options: McpOptions): Promise<void> {
  const httpServer = createServer((req, res) => {
    handleHttpMcpRequest(req, res, options.path).catch((error) => {
      console.error('MCP HTTP request failed:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
      }
      res.end('Internal Server Error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });

  console.error(`aicw-ai-mentions MCP HTTP server listening at http://${options.host}:${options.port}${options.path}`);
}

async function startStdioServer(): Promise<void> {
  const server = createAicwMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function startMcpServer(args: string[] = []): Promise<void> {
  const options = parseArgs(args);
  if (options.transport === 'http') {
    await startHttpServer(options);
    return;
  }

  await startStdioServer();
}
