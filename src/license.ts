/**
 * License command - displays license information
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { getPackageRoot } from './config/user-paths.js';
import { colorize } from './utils/misc-utils.js';

async function main() {
  console.log(colorize('\n📜 aicw-ai-mentions - License Information', 'bright'));
  console.log(colorize('━'.repeat(50), 'dim'));

  const licensePath = join(getPackageRoot(), 'LICENSE');

  try {
    const content = await fs.readFile(licensePath, 'utf-8');
    console.log('\n' + content);
  } catch (error: any) {
    console.error(colorize(`\n✗ Unable to load license: ${error.message}`, 'red'));
  }
}

main().catch(err => {
  console.error(err.message || err.toString());
  throw err;
});
