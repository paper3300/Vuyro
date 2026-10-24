// Usage: node tools/demo/scripts/create-sample.ts <empty folder outside this repository>
import { fileURLToPath } from 'node:url';
import { createSampleRepository } from '../src/create-sample.ts';

const target = process.argv[2];
if (target === undefined || target === '') {
  console.error('usage: create-sample.ts <empty folder outside the Vuyro repository>');
  process.exit(2);
}
// The Vuyro repository is three levels up from this script.
const { root, commit } = createSampleRepository(target, fileURLToPath(new URL('../../..', import.meta.url)));
console.log(`sample notepad repository: ${root} (${commit.slice(0, 12)})`);
