import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createAicwMcpServer } from '../dist/mcp-server.js';

test('MCP server exposes AICW tools', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAicwMcpServer();
  const client = new Client({ name: 'aicw-ai-mentions-test', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();

  assert.ok(toolNames.includes('aicw_data_location'));
  assert.ok(toolNames.includes('aicw_get_project'));
  assert.ok(toolNames.includes('aicw_list_projects'));
  assert.ok(toolNames.includes('aicw_openrouter_key_status'));
  assert.ok(toolNames.includes('aicw_rebuild_report'));
  assert.ok(toolNames.includes('aicw_scan'));
  assert.ok(toolNames.includes('aicw_set_openrouter_api_key'));

  const dataLocation = await client.callTool({
    name: 'aicw_data_location',
    arguments: {},
  });

  assert.equal(dataLocation.content[0].type, 'text');
  assert.match(dataLocation.content[0].text, /"dataDir"/);

  await client.close();
  await server.close();
});
