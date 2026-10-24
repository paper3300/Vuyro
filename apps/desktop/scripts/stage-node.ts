// Copies the Node that runs this script into build/node/ for the installer (L-13: the installed app carries its
// own Node 24 for the engine and the vuyro CLI). Refuses any Node other than 24.16 or later 24.x.
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 16) {
  console.error(`stage-node: Node ${process.versions.node} is not 24.16 or a later 24.x`);
  process.exit(1);
}
const target = fileURLToPath(new URL('../build/node/', import.meta.url));
mkdirSync(target, { recursive: true });
copyFileSync(process.execPath, join(target, basename(process.execPath)));
console.log(`stage-node: Node ${process.versions.node} -> ${target}`);
