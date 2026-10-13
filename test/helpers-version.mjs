// 从 src/worker/version-*.js 读取两个脚本各自的当前版本号（测试用，避免版本号升级后改测试）
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL('../src/worker/' + f, import.meta.url), 'utf8').match(/const VERSION = '([^']+)'/)[1];
export const PANEL_VERSION = read('version-panel.js');
export const PROXY_VERSION = read('version-proxy.js');
