// 从 src/worker/version.js 读取当前版本号（测试用，避免版本号升级后改测试）
import { readFileSync } from 'node:fs';
export const VERSION_FOR_TEST = readFileSync(new URL('../src/worker/version.js', import.meta.url), 'utf8').match(/const VERSION = '([^']+)'/)[1];
