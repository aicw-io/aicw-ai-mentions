/**
 * Help command - displays documentation
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { getPackageRoot } from './config/user-paths.js';
import { colorize } from './utils/misc-utils.js';

async function main() {
  console.log(colorize('\n📚 aicw-ai-mentions - Help & Documentation', 'bright'));
  console.log(colorize('━'.repeat(50), 'dim'));

  // Read and display README.md
  const readmePath = join(getPackageRoot(), 'README.md');

  try {
    const content = await fs.readFile(readmePath, 'utf-8');
    console.log('\n' + content);
  } catch (error: any) {
    console.error(colorize(`\n✗ Unable to load documentation: ${error.message}`, 'red'));
  }
}

main().catch(err => {
  console.error(err.message || err.toString());
  throw err;
});
