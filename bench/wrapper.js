// 测试入口：原样的代理模块 + 内存里的 NODE_KV（返回 STATE_JSON 绑定里的状态）。KV 对象在 isolate 生命周期内只有一个，
// 代理自己的 STATE_MEM 缓存与绑定真实 KV 时完全一样
import proxy from './proxy.js';
let kv = null, env2 = null;
export default {
  fetch(request, env, ctx) {
    if (!env2) {
      kv = { get: async () => env.STATE_JSON, put: async () => {} };
      env2 = { PATH: env.PATH, NODE_KEY: env.NODE_KEY, NODE_KV: kv };
    }
    return proxy.fetch(request, env2, ctx);
  },
};
