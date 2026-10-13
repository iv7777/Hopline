// ---------------------------------------------------------------------------
// 内嵌页面与模板（构建时内联进脚本，运行时不依赖网络）
// ---------------------------------------------------------------------------
const loginHTML = /* @inline panel/login.html */ '';
// Clash / Stash 订阅的配置模板：生成订阅时拼在节点后面
const CLASH_TEMPLATE = /* @inline worker/clash-template.yaml */ '';
// 面板页面模板（HTML + CSS + JS）：发给浏览器前注入字段表等运行时数据
const PANEL_TEMPLATE = /* @inline panel/panel.html */ '';

// 面板页面：在模板上注入字段表与共用校验函数（每个 isolate 只组装一次）
let PANEL_PAGE = null;
function panelPage() {
  if (PANEL_PAGE) return PANEL_PAGE;
  PANEL_PAGE = PANEL_TEMPLATE
    .replace('/*@HOPLINE_SCHEMA@*/null', () => JSON.stringify(clientSchema()).replace(/</g, '\\u003c'))
    .replace('/*@HOPLINE_CHECK@*/null', () => '(' + checkFieldValue.toString() + ')')
    .replace('/*@HOPLINE_HTTP_PORTS@*/null', () => JSON.stringify([...HTTP_PORTS]));
  return PANEL_PAGE;
}
