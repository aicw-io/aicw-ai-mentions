import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('main report tabs are ordered mentions, links, link domains', () => {
  const template = readFileSync(
    path.join(process.cwd(), 'src/config/data/templates/report/html/projects/project/question/index-static.html'),
    'utf8'
  );
  const reportGenerator = readFileSync(
    path.join(process.cwd(), 'src/utils/report-main-static.ts'),
    'utf8'
  );

  const navStart = template.indexOf('<!-- Tab Navigation -->');
  assert.notEqual(navStart, -1);

  const mentionsIndex = template.indexOf('>Mentions', navStart);
  const linksIndex = template.indexOf('>Links', navStart);
  const domainsIndex = template.indexOf('>Link Domains', navStart);

  assert.ok(mentionsIndex !== -1, 'Mentions tab is missing');
  assert.ok(linksIndex !== -1, 'Links tab is missing');
  assert.ok(domainsIndex !== -1, 'Link Domains tab is missing');
  assert.ok(mentionsIndex < linksIndex, 'Mentions should be before Links');
  assert.ok(linksIndex < domainsIndex, 'Links should be before Link Domains');
  assert.doesNotMatch(template, />Sources</);
  assert.match(template, /panel-domains/);
  assert.match(template, /aicw-ai-mentions_link-domains_/);
  assert.match(template, /data-table-model-select/);
  assert.match(template, /All models/);
  assert.match(template, /setTableModelFilter/);
  assert.match(reportGenerator, /data-model-response-button/);
  assert.match(reportGenerator, /View Response/);
  assert.match(reportGenerator, />About/);
  assert.match(reportGenerator, /formatDateHeader/);
  assert.doesNotMatch(reportGenerator, /About This Report/);
  assert.doesNotMatch(reportGenerator, />Scope</);
  assert.doesNotMatch(reportGenerator, />Detected</);
  assert.doesNotMatch(reportGenerator, />Top Mentions</);
  assert.doesNotMatch(reportGenerator, />Generated</);
  assert.match(template, /openModelResponse/);
  assert.match(template, /answer-modal/);
  assert.match(template, /REPORT_QUESTIONS_JSON/);
  assert.match(template, /answer-response-markdown/);
  assert.match(template, /setAnswerTab/);
  assert.match(template, /Created with AICW AI Mentions/);
  assert.match(template, /https:\/\/aicw\.io\/aicw-ai-mentions/);
  assert.match(reportGenerator, /truncateMiddle/);
  assert.match(reportGenerator, /data-export-value/);
  assert.doesNotMatch(template, /View all categories/);
  assert.doesNotMatch(template, /github\.com\/aicw-io\/aicw-ai-mentions/);
});

test('public report templates link AICW AI Mentions to the product page', () => {
  const templateFiles = [
    'src/config/data/templates/navigation/home.html',
    'src/config/data/templates/navigation/project-detail.html',
    'src/config/data/templates/report/html/projects/project/question/index-static.html',
    'src/config/data/templates/report/html/projects/project/question/mention/mention-page.html',
    'src/config/data/templates/report/html/projects/project/question/website/source-page.html',
  ];

  for (const file of templateFiles) {
    const template = readFileSync(path.join(process.cwd(), file), 'utf8');
    assert.doesNotMatch(template, /github\.com\/aicw-io\/aicw-ai-mentions/, file);
  }

  const combined = templateFiles
    .map(file => readFileSync(path.join(process.cwd(), file), 'utf8'))
    .join('\n');
  assert.match(combined, /https:\/\/www\.aicw\.io\/aicw-ai-mentions/);
});
