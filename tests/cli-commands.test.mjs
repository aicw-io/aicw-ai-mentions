import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getTargetDateArg, resolveCommandAlias } from '../dist/utils/cli-commands.js';
import { parseProjectNewArgs, resolveQuestionCount } from '../dist/actions/project-new-args.js';

test('resolves public command aliases', () => {
  assert.equal(resolveCommandAlias('scan'), 'new');
  assert.equal(resolveCommandAlias('serve'), 'report-serve');
  assert.equal(resolveCommandAlias('build'), 'build');
});

test('extracts target date from command args', () => {
  assert.equal(getTargetDateArg(['Example', '--date', '2026-05-09']), '2026-05-09');
  assert.equal(getTargetDateArg(['Example']), undefined);
});

test('parses noninteractive scan subject and question count', () => {
  assert.deepEqual(parseProjectNewArgs(['Stripe', '--questions', '2']), {
    topic: 'Stripe',
    questionCount: 2
  });
  assert.deepEqual(parseProjectNewArgs(['Stripe', '--questions=3']), {
    topic: 'Stripe',
    questionCount: 3
  });
  assert.deepEqual(parseProjectNewArgs(['Stripe', '--template', './questions.md']), {
    topic: 'Stripe',
    templatePath: './questions.md'
  });
  assert.deepEqual(parseProjectNewArgs(['Stripe', '--template=./questions.md']), {
    topic: 'Stripe',
    templatePath: './questions.md'
  });
  assert.deepEqual(parseProjectNewArgs(['Stripe', '--template-text', 'Who cites {{SUBJECT}}?']), {
    topic: 'Stripe',
    templateText: 'Who cites {{SUBJECT}}?'
  });
  assert.deepEqual(parseProjectNewArgs(['Stripe', '--template-text=Who cites {{SUBJECT}}?']), {
    topic: 'Stripe',
    templateText: 'Who cites {{SUBJECT}}?'
  });
  assert.deepEqual(parseProjectNewArgs(['Stripe', '--template-inline=Who cites {{SUBJECT}}?']), {
    topic: 'Stripe',
    templateText: 'Who cites {{SUBJECT}}?'
  });
});

test('validates requested question count', () => {
  assert.equal(resolveQuestionCount(undefined, 5, 5), 5);
  assert.equal(resolveQuestionCount(4, 5, 5), 4);
  assert.throws(() => resolveQuestionCount(6, 5, 5), /between 1 and 5/);
});

test('npm package is unscoped and exposes the public binary', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

  assert.equal(packageJson.name, 'aicw-ai-mentions');
  assert.equal(packageLock.name, 'aicw-ai-mentions');
  assert.equal(packageLock.packages[''].name, 'aicw-ai-mentions');
  assert.equal(packageJson.publishConfig.registry, 'https://registry.npmjs.org/');
  assert.equal(packageJson.scripts['publish:npm'], undefined);
  assert.deepEqual(packageJson.bin, {
    'aicw-ai-mentions': './bin/aicw-ai-mentions.js'
  });
  assert.ok(packageJson.files.includes('skills/'));
});

test('link verification is optional and not part of default build pipelines', () => {
  const pipelines = JSON.parse(readFileSync('src/config/data/pipelines.json', 'utf8'));
  const verifyAction = pipelines.actions.find(action => action.id === 'verify-links');

  assert.ok(verifyAction, 'verify-links action should exist');
  assert.deepEqual(verifyAction.pipelines, ['verify-links']);
});
