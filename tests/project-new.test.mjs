import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('project-new creates a scan from a subject argument without prompts', () => {
  const dataDir = mkdtempSync(path.join(process.cwd(), '.test-data-project-new-'));

  try {
    const result = spawnSync(process.execPath, ['dist/actions/project-new.js', 'Acme Corp'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICW_DATA_FOLDER: dataDir,
        AICW_INTERACTIVE_MODE: 'true',
        AICW_PIPELINE_STEP: '1'
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /AICW_OUTPUT_STRING:Acme Corp/);
    assert.match(result.stdout, /Questions for "Acme Corp" \(3\)/);
    assert.match(result.stdout, /Which sources would you cite to verify important claims about Acme Corp/);

    const projectJson = JSON.parse(
      readFileSync(path.join(dataDir, 'projects', 'Acme Corp', 'project.json'), 'utf8')
    );
    const questions = readFileSync(
      path.join(dataDir, 'projects', 'Acme Corp', 'questions.md'),
      'utf8'
    );

    assert.equal(projectJson.display_name, 'Acme Corp');
    assert.equal(projectJson.ai_preset, 'ai_chats_with_search');
    assert.match(projectJson.description, /LLM perception scan/);
    assert.match(questions, /What is Acme Corp known for today/);
    assert.match(questions, /Which sources would you cite to verify important claims about Acme Corp/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('project-new accepts a custom question template file', () => {
  const dataDir = mkdtempSync(path.join(process.cwd(), '.test-data-project-template-'));
  const templatePath = path.join(dataDir, 'custom-questions.md');

  try {
    writeFileSync(
      templatePath,
      [
        '# Custom questions',
        '',
        '- Who mentions {{SUBJECT}} and why?',
        '2. Which sources cite {{SUBJECT}}?',
        'What competitors appear near {{SUBJECT}}?'
      ].join('\n')
    );

    const result = spawnSync(process.execPath, ['dist/actions/project-new.js', 'Acme Template', '--template', templatePath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICW_DATA_FOLDER: dataDir,
        AICW_INTERACTIVE_MODE: 'true',
        AICW_PIPELINE_STEP: '1'
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Generated 3 scan questions from/);

    const questions = readFileSync(
      path.join(dataDir, 'projects', 'Acme Template', 'questions.md'),
      'utf8'
    );

    assert.match(questions, /Who mentions Acme Template and why/);
    assert.match(questions, /Which sources cite Acme Template/);
    assert.match(questions, /What competitors appear near Acme Template/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('project-new accepts an inline question template string', () => {
  const dataDir = mkdtempSync(path.join(process.cwd(), '.test-data-project-inline-template-'));

  try {
    const result = spawnSync(
      process.execPath,
      [
        'dist/actions/project-new.js',
        'Inline Subject',
        '--template-text',
        'Who mentions {{SUBJECT}}?\\n2. Which links cite {{SUBJECT}}?'
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AICW_DATA_FOLDER: dataDir,
          AICW_INTERACTIVE_MODE: 'true',
          AICW_PIPELINE_STEP: '1'
        },
        encoding: 'utf8'
      }
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Generated 2 scan questions from --template-text/);

    const questions = readFileSync(
      path.join(dataDir, 'projects', 'Inline Subject', 'questions.md'),
      'utf8'
    );

    assert.match(questions, /Who mentions Inline Subject/);
    assert.match(questions, /Which links cite Inline Subject/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('project-new rejects using a template file and inline template together', () => {
  const dataDir = mkdtempSync(path.join(process.cwd(), '.test-data-project-template-conflict-'));
  const templatePath = path.join(dataDir, 'custom-questions.md');

  try {
    writeFileSync(templatePath, 'Who mentions {{SUBJECT}}?');

    const result = spawnSync(
      process.execPath,
      [
        'dist/actions/project-new.js',
        'Template Conflict',
        '--template',
        templatePath,
        '--template-text',
        'Which links cite {{SUBJECT}}?'
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AICW_DATA_FOLDER: dataDir,
          AICW_INTERACTIVE_MODE: 'true',
          AICW_PIPELINE_STEP: '1'
        },
        encoding: 'utf8'
      }
    );

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /Use either --template or --template-text/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('scan command checks the full pipeline chain before creating a project', () => {
  const dataDir = mkdtempSync(path.join(process.cwd(), '.test-data-scan-command-'));

  try {
    const result = spawnSync(process.execPath, ['bin/aicw-ai-mentions.js', 'scan', 'No Key Smoke'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICW_DATA_FOLDER: dataDir,
        AICW_SKIP_UPDATE_CHECK: 'true',
        OPENAI_API_KEY: '',
        OPENROUTER_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        PERPLEXITY_API_KEY: ''
      },
      encoding: 'utf8'
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /API keys are not set/);
    assert.equal(existsSync(path.join(dataDir, 'projects', 'No Key Smoke')), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('scan command explains copied encrypted credentials that cannot decrypt', () => {
  const dataDir = mkdtempSync(path.join(process.cwd(), '.test-data-bad-credentials-'));
  const credentialsDir = path.join(dataDir, 'config', '.credentials');

  try {
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(
      path.join(credentialsDir, 'credentials.json'),
      JSON.stringify({
        version: '1.0',
        encrypted: true,
        credentials: {
          OPENROUTER_API_KEY: {
            data: Buffer.from('not-a-real-key').toString('base64'),
            iv: Buffer.alloc(16).toString('base64'),
            tag: Buffer.alloc(16).toString('base64')
          }
        }
      })
    );

    const result = spawnSync(process.execPath, ['bin/aicw-ai-mentions.js', 'scan', 'Bad Credentials Smoke'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICW_DATA_FOLDER: dataDir,
        AICW_SKIP_UPDATE_CHECK: 'true',
        OPENAI_API_KEY: '',
        OPENROUTER_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        PERPLEXITY_API_KEY: ''
      },
      encoding: 'utf8'
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /Credentials file exists but could not be decrypted/);
    assert.match(output, /setup-api-key/);
    assert.equal(existsSync(path.join(dataDir, 'projects', 'Bad Credentials Smoke')), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('build command writes logs under AICW_DATA_FOLDER', () => {
  const dataDir = mkdtempSync(path.join(process.cwd(), '.test-data-build-logs-'));

  try {
    const result = spawnSync(process.execPath, ['bin/aicw-ai-mentions.js', 'build', 'Missing Project'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AICW_DATA_FOLDER: dataDir,
        AICW_SKIP_UPDATE_CHECK: 'true',
        OPENAI_API_KEY: 'test-key',
        OPENROUTER_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        PERPLEXITY_API_KEY: ''
      },
      encoding: 'utf8'
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    assert.doesNotMatch(output, /EPERM: operation not permitted, mkdir '\/Users\/mine\/\.aicw/);
    assert.equal(existsSync(path.join(dataDir, 'logs')), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('help command exits in noninteractive usage', () => {
  const result = spawnSync(process.execPath, ['bin/aicw-ai-mentions.js', 'help'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AICW_SKIP_UPDATE_CHECK: 'true'
    },
    encoding: 'utf8',
    timeout: 5000
  });

  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /aicw-ai-mentions/);
  assert.doesNotMatch(output, /ETIMEDOUT/);
});

test('pipeline executor forwards scan options to project-new action', async () => {
  const dataDir = mkdtempSync(path.join(process.cwd(), '.test-data-forwarded-scan-options-'));
  const previousDataFolder = process.env.AICW_DATA_FOLDER;
  const previousSkipUpdate = process.env.AICW_SKIP_UPDATE_CHECK;

  try {
    process.env.AICW_DATA_FOLDER = dataDir;
    process.env.AICW_SKIP_UPDATE_CHECK = 'true';

    const { PipelineExecutor } = await import('../dist/utils/pipeline-executor.js');
    const executor = new PipelineExecutor('Forwarded Options Smoke');
    const result = await executor.executePipeline({
      id: 'test-new',
      name: 'Test New',
      description: 'test project creation',
      category: 'project',
      actions: [{
        id: 'project-new',
        cmd: 'actions/project-new',
        name: 'Create perception scan',
        desc: 'Create focused questions',
        pipelines: ['test-new'],
        category: 'project',
        requiresProject: false,
        requiresConsolePipeReturn: true
      }]
    }, {
      showHints: false,
      actionArgs: { 'project-new': ['--questions', '1'] }
    });

    assert.equal(result.success, true, result.error?.message);

    const questions = readFileSync(
      path.join(dataDir, 'projects', 'Forwarded Options Smoke', 'questions.md'),
      'utf8'
    )
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#'));

    assert.equal(questions.length, 1);
  } finally {
    if (previousDataFolder === undefined) {
      delete process.env.AICW_DATA_FOLDER;
    } else {
      process.env.AICW_DATA_FOLDER = previousDataFolder;
    }

    if (previousSkipUpdate === undefined) {
      delete process.env.AICW_SKIP_UPDATE_CHECK;
    } else {
      process.env.AICW_SKIP_UPDATE_CHECK = previousSkipUpdate;
    }

    rmSync(dataDir, { recursive: true, force: true });
  }
});
