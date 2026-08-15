import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BillingUsageReport } from "../shared/billing.js";
import type { ChangeBatch, DesktopInfo, FileDiff, McpVisionBackendConfig, VisionBackendConfig, VisionResult, VisionSettings } from "../shared/contracts.js";
import { editor } from "./monaco.js";
import "./styles.css";

type View = "changes" | "billing" | "vision" | "settings";
const VIEWS: Array<{ id: View; label: string; glyph: string }> = [
  { id: "changes", label: "变更", glyph: "±" }, { id: "billing", label: "用量", glyph: "¥" },
  { id: "vision", label: "视觉", glyph: "◎" }
];
const WORKBENCH_VIEWS = new Set<View>(["changes", "billing", "vision", "settings"]);

function useTheme(info: DesktopInfo | null) {
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = info?.themePreference === "dark" || (info?.themePreference !== "light" && query.matches);
      document.body.toggleAttribute("data-ds-dark-theme", dark); document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply(); query.addEventListener("change", apply); return () => query.removeEventListener("change", apply);
  }, [info?.themePreference]);
}

function DiffEditor({ value, inline, ignoreWhitespace }: { value: FileDiff; inline: boolean; ignoreWhitespace: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const original = editor.createModel(value.original, value.language);
    const modified = editor.createModel(value.modified, value.language);
    const instance = editor.createDiffEditor(ref.current, {
      automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: !inline,
      ignoreTrimWhitespace: ignoreWhitespace, renderOverviewRuler: true, minimap: { enabled: false },
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--ds-font-family-code").trim() || "Consolas, 'Microsoft YaHei', monospace", fontSize: 12.5,
      lineHeight: 20, scrollBeyondLastLine: false, folding: true, renderIndicators: true
    });
    instance.setModel({ original, modified });
    return () => { instance.dispose(); original.dispose(); modified.dispose(); };
  }, [value, inline, ignoreWhitespace]);
  return <div className="diff-editor" ref={ref} />;
}

function ChangesView({ notify, workspacePath }: { notify: (message: string, error?: boolean) => void; workspacePath: string | null }) {
  const [batches, setBatches] = useState<ChangeBatch[]>([]); const [batchId, setBatchId] = useState("");
  const [filePath, setFilePath] = useState(""); const [diff, setDiff] = useState<FileDiff | null>(null);
  const [title, setTitle] = useState(""); const [inline, setInline] = useState(false); const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const batch = batches.find((entry) => entry.id === batchId) ?? batches[0];
  const refresh = async () => { const next = await window.desktop.listChangeBatches(); setBatches(next); if (!batchId && next[0]) setBatchId(next[0].id); };
  useEffect(() => { void refresh(); return window.desktop.onChangeBatchesChanged(setBatches); }, []);
  useEffect(() => { if (!batch?.files.some((file) => file.path === filePath)) { setFilePath(batch?.files[0]?.path ?? ""); setDiff(null); } }, [batch?.id, batch?.files.length]);
  useEffect(() => { if (!batch || !filePath) { setDiff(null); return; } window.desktop.getFileDiff(batch.id, filePath).then(setDiff).catch((error) => { setDiff(null); notify(String(error), true); }); }, [batch?.id, filePath]);
  const act = async (task: () => Promise<unknown>, message: string) => { try { await task(); await refresh(); notify(message); } catch (error) { notify(error instanceof Error ? error.message : String(error), true); } };
  return <div className="feature-layout changes-feature">
    <aside className="context-panel">
      <div className="panel-title"><div><h2>本次任务</h2><small title={workspacePath ?? undefined}>{workspacePath ?? "请先在 Harness 打开对话"}</small></div><span className="count">{batches.length}</span></div>
      <form className="batch-create" onSubmit={(event) => { event.preventDefault(); void act(async () => { const created = await window.desktop.createChangeBatch(title || "新任务"); setTitle(""); setBatchId(created.id); }, "已捕获任务基线"); }}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="任务标题" aria-label="任务标题" disabled={!workspacePath}/><button className="primary" disabled={!workspacePath} title={workspacePath ? "捕获当前对话工作区基线" : "请先在 Harness 打开一个工作区对话"}>开始</button>
      </form>
      <select className="batch-select" value={batch?.id ?? ""} onChange={(event) => { setBatchId(event.target.value); setFilePath(""); }} aria-label="变更批次">
        {!batches.length && <option value="">暂无变更批次</option>}{batches.map((entry) => <option key={entry.id} value={entry.id}>{entry.state === "capturing" ? "● " : ""}{entry.title}</option>)}
      </select>
      {batch?.state === "capturing" && <button className="wide-button" onClick={() => void act(() => window.desktop.closeChangeBatch(batch.id), "已生成本次任务 Diff")}>结束并生成 Diff</button>}
      {batch && <div className="batch-meta"><span>{new Date(batch.createdAt).toLocaleString()}</span><span>{batch.preexistingDirtyPaths.length} 个任务前变更已隔离</span></div>}
      <div className="section-label">文件</div>
      <div className="file-list">{batch?.files.map((file) => <button key={file.path} className={`file-row ${file.path === filePath ? "active" : ""}`} onClick={() => setFilePath(file.path)}>
        <span className={`change-kind kind-${file.kind}`}>{file.kind[0]!.toUpperCase()}</span><span className="file-name">{file.path}</span><span className="delta"><i>+{file.additions}</i> <b>-{file.deletions}</b></span>
      </button>)}{batch?.state === "ready" && !batch.files.length && <div className="empty-small">这个任务没有文件修改。</div>}</div>
      {!!batch?.preexistingDirtyPaths.length && <details className="preexisting"><summary>任务前已有变更</summary>{batch.preexistingDirtyPaths.map((item) => <div key={item}>{item}</div>)}</details>}
    </aside>
    <main className="stage">
      <div className="editor-toolbar"><span className="breadcrumb">{diff?.path ?? "选择一个文件查看变更"}</span><div className="toolbar-actions"><button className={inline ? "" : "active"} onClick={() => setInline(false)}>并排</button><button className={inline ? "active" : ""} onClick={() => setInline(true)}>行内</button><label><input type="checkbox" checked={ignoreWhitespace} onChange={(event) => setIgnoreWhitespace(event.target.checked)}/>忽略空白</label></div></div>
      {diff ? diff.change.binary ? <Empty title="二进制文件" detail="此文件只显示变更状态，不生成文本 Diff。"/> : <DiffEditor value={diff} inline={inline} ignoreWhitespace={ignoreWhitespace}/> : <Empty title="等待审阅" detail="开始任务时捕获基线，任务完成后生成与任务前状态的精确对比。"/>}
    </main>
    <aside className="inspector"><span className="eyebrow">REVIEW</span><h3>审阅与撤销</h3>{diff ? <>
      <div className="metric-strip"><span><b>{diff.change.additions}</b> 新增</span><span><b>{diff.change.deletions}</b> 删除</span></div>
      <button className="wide-button" onClick={() => void act(() => window.desktop.markChangeReviewed(diff.batchId, diff.path), "文件已标记为审阅")}>标记文件已审阅</button>
      <button className="wide-button danger" onClick={() => confirm(`撤销 ${diff.path} 的全部本次修改？`) && void act(() => window.desktop.revertChangeFile(diff.batchId, diff.path), "文件修改已撤销")}>撤销文件</button>
      <div className="section-label">代码块</div>{diff.change.hunks.map((hunk, index) => <div className="hunk" key={hunk.id}><div><b>变更 {index + 1}</b><code>{hunk.header}</code></div><div><button onClick={() => void act(() => window.desktop.markChangeReviewed(diff.batchId, diff.path, hunk.id), "代码块已审阅")}>已审阅</button><button onClick={() => confirm("只撤销这个代码块？") && void act(() => window.desktop.revertChangeHunk(diff.batchId, diff.path, hunk.id), "代码块已撤销")}>撤销此处</button></div></div>)}</> : <p className="muted">选择文件后，可逐块审阅或安全撤销。文件哈希不一致时撤销会自动停止。</p>}</aside>
  </div>;
}

function BillingView() {
  const [report, setReport] = useState<BillingUsageReport | null>(null);
  useEffect(() => { window.desktop.getBillingUsage().then(setReport); return window.desktop.onBillingUsageChanged(setReport); }, []);
  return <div className="single-feature"><header className="feature-header"><div><span className="eyebrow">USAGE LEDGER</span><h1>用量与费用</h1><p>来自 Harness 会话投影的本地费用估算。</p></div><div className="horizontal-actions"><button onClick={() => window.desktop.checkBillingPrices()}>更新价格清单</button><button className="primary" onClick={() => window.desktop.openLegacyBilling()}>管理价格规则</button></div></header>
    <div className="summary-grid"><Summary label="请求" value={String(report?.requests ?? 0)}/><Summary label="输入 Token" value={(report?.inputTokens ?? 0).toLocaleString()}/><Summary label="输出 Token" value={(report?.outputTokens ?? 0).toLocaleString()}/><Summary label="累计费用" value={report?.totals.map((item) => item.display).join(" · ") || "—"}/></div>
    <section className="data-section"><div className="section-heading"><h2>对话明细</h2><span>{report?.sessions.length ?? 0} 个对话</span></div><div className="table"><div className="table-row table-head"><span>对话</span><span>请求</span><span>Token</span><span>费用</span></div>{report?.sessions.map((session) => <div className="table-row" key={session.sessionId}><span><b>{session.title}</b><small>{session.models.map((model) => model.model).join(" · ")}</small></span><span>{session.requests}</span><span>{(session.inputTokens + session.outputTokens).toLocaleString()}</span><span>{session.totals.map((item) => item.display).join(" · ") || "未定价"}</span></div>)}</div></section>
  </div>;
}

const emptyMapping = { imageArgument: "image", imageEncoding: "data-url" as const, questionArgument: "prompt", mimeTypeArgument: "mimeType", resultTextPath: null };
function directPreset(): VisionBackendConfig { return { id: crypto.randomUUID(), kind: "direct", name: "千问视觉", enabled: true, model: "qwen-vl-max", timeoutMs: 60_000, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", credentialName: "DASHSCOPE_API_KEY", headers: {}, headerCredentialNames: {} }; }
function mcpPreset(): McpVisionBackendConfig { return { id: crypto.randomUUID(), kind: "mcp", transport: "stdio", name: "本地视觉 MCP", enabled: true, model: "由 MCP 管理", timeoutMs: 60_000, command: "npx", args: [], cwd: "", env: {}, envCredentialNames: {}, allowLocalPath: false, toolName: "", mapping: emptyMapping }; }

function VisionView({ notify }: { notify: (message: string, error?: boolean) => void }) {
  const [settings, setSettings] = useState<VisionSettings | null>(null); const [selectedId, setSelectedId] = useState(""); const [tools, setTools] = useState<string[]>([]);
  const [secret, setSecret] = useState(""); const [image, setImage] = useState<string>(""); const [mime, setMime] = useState("image/png"); const [question, setQuestion] = useState("请描述图片中的界面、文字和重要细节。"); const [result, setResult] = useState<VisionResult | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { window.desktop.getVisionSettings().then((value) => { setSettings(value); setSelectedId(value.defaultBackendId ?? value.backends[0]?.id ?? ""); }); }, []);
  const backend = settings?.backends.find((entry) => entry.id === selectedId);
  const patchBackend = (update: Partial<VisionBackendConfig>) => setSettings((current) => current ? { ...current, backends: current.backends.map((entry) => entry.id === selectedId ? { ...entry, ...update } as VisionBackendConfig : entry) } : current);
  const save = async () => { if (!settings) return; try { const value = await window.desktop.setVisionSettings(settings); setSettings(value); notify("视觉服务设置已保存"); } catch (error) { notify(String(error), true); } };
  const add = (value: VisionBackendConfig) => { setSettings((current) => current ? { ...current, backends: [...current.backends, value], defaultBackendId: current.defaultBackendId ?? value.id } : current); setSelectedId(value.id); };
  const analyze = async () => { if (!image || !backend) return; const requestId = crypto.randomUUID(); setBusy(true); setResult(null); try { setResult(await window.desktop.analyzeVision({ requestId, backendId: backend.id, question, imageDataUrl: image, mimeType: mime })); } catch (error) { notify(error instanceof Error ? error.message : String(error), true); } finally { setBusy(false); } };
  if (!settings) return <Empty title="正在载入视觉服务" detail="读取加密凭据与后端配置…"/>;
  return <div className="feature-layout vision-feature"><aside className="context-panel"><div className="panel-title"><div><span className="eyebrow">VISION BRIDGE</span><h2>视觉服务</h2></div><span className="count">{settings.backends.length}</span></div><div className="stack-actions"><button onClick={() => add(directPreset())}>＋ Direct API</button><button onClick={() => add(mcpPreset())}>＋ MCP 服务</button></div><div className="backend-list">{settings.backends.map((item) => <button key={item.id} className={item.id === selectedId ? "active" : ""} onClick={() => setSelectedId(item.id)}><span className={`status ${item.enabled ? "online" : ""}`}/><span><b>{item.name}</b><small>{item.kind === "direct" ? "OpenAI-compatible" : `${item.transport} · ${item.toolName || "未选工具"}`}</small></span>{item.id === settings.defaultBackendId && <em>默认</em>}</button>)}</div></aside>
    <main className="stage scroll-stage"><div className="feature-header compact"><div><span className="eyebrow">CONFIGURATION</span><h1>{backend?.name ?? "添加一个视觉服务"}</h1><p>纯文本主模型只接收视觉服务返回的文字结果。</p></div><div className="horizontal-actions">{backend && <><button onClick={async () => { try { const tested = await window.desktop.testVisionBackend(backend); notify(tested.tools ? `连接成功，发现 ${tested.tools.length} 个工具` : "视觉 API 连接成功"); } catch (error) { notify(String(error), true); } }}>测试连接</button><button className="danger" onClick={() => { setSettings({ ...settings, backends: settings.backends.filter((item) => item.id !== backend.id), defaultBackendId: settings.defaultBackendId === backend.id ? null : settings.defaultBackendId }); setSelectedId(""); }}>删除</button></>}<button className="primary" onClick={() => void save()}>保存设置</button></div></div>{backend ? <div className="form-sections">
      <section className="form-section"><h3>基本信息</h3><div className="form-grid"><Field label="名称"><input value={backend.name} onChange={(e) => patchBackend({ name: e.target.value })}/></Field><Field label="模型"><input value={backend.model} onChange={(e) => patchBackend({ model: e.target.value })}/></Field><Field label="超时（毫秒）"><input type="number" value={backend.timeoutMs} onChange={(e) => patchBackend({ timeoutMs: Number(e.target.value) })}/></Field><label className="check-field"><input type="checkbox" checked={backend.enabled} onChange={(e) => patchBackend({ enabled: e.target.checked })}/>启用此服务</label></div></section>
      {backend.kind === "direct" ? <section className="form-section"><h3>OpenAI-compatible API</h3><div className="form-grid"><Field label="Base URL"><input value={backend.baseUrl} onChange={(e) => patchBackend({ baseUrl: e.target.value })}/></Field><Field label="凭据名称"><input value={backend.credentialName} onChange={(e) => patchBackend({ credentialName: e.target.value.toUpperCase() })}/></Field><Field label="保存密钥"><div className="inline"><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="不会写入设置文件"/><button onClick={async () => { await window.desktop.setCredential(backend.credentialName, secret); setSecret(""); notify("密钥已加密保存"); }}>保存</button></div></Field><JsonRecordField label="普通请求头（JSON）" value={backend.headers} onChange={(headers) => patchBackend({ headers })}/><JsonRecordField label="请求头到凭据名称（JSON）" value={backend.headerCredentialNames} onChange={(headerCredentialNames) => patchBackend({ headerCredentialNames })}/></div></section> : <McpFields backend={backend} patchBackend={patchBackend} tools={tools} discover={async () => { try { const found = await window.desktop.discoverVisionTools(backend); setTools(found.map((item) => item.name)); notify(`发现 ${found.length} 个工具`); } catch (error) { notify(String(error), true); } }}/>} 
      <section className="form-section"><h3>默认策略</h3><div className="form-grid"><Field label="桥接模式"><select value={settings.policy} onChange={(e) => setSettings({ ...settings, policy: e.target.value as VisionSettings["policy"] })}><option value="auto">自动（仅纯文本模型）</option><option value="always">总是解析</option><option value="off">关闭</option></select></Field><label className="check-field"><input type="checkbox" checked={settings.defaultBackendId === backend.id} onChange={() => setSettings({ ...settings, defaultBackendId: backend.id })}/>设为默认服务</label><label className="check-field warning-check"><input type="checkbox" checked={settings.remoteDisclosureAccepted} onChange={(e) => setSettings({ ...settings, remoteDisclosureAccepted: e.target.checked })}/>我了解远程服务会接收所选图片</label></div></section>
    </div> : <Empty title="还没有视觉服务" detail="添加 Direct API 或任意兼容的 MCP 服务。千问只是可选预设。"/>}</main>
    <aside className="inspector vision-test"><span className="eyebrow">LIVE TEST</span><h3>发送前测试</h3><p className="muted">图片解析失败时不会继续发送给主模型。</p><label className="image-drop"><input type="file" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; setMime(file.type); const reader = new FileReader(); reader.onload = () => setImage(String(reader.result)); reader.readAsDataURL(file); }}/>{image ? <img src={image}/> : <span>选择测试图片<br/><small>最大 20 MB</small></span>}</label><textarea value={question} onChange={(e) => setQuestion(e.target.value)}/><button className="primary wide-button" disabled={!image || !backend || busy} onClick={() => void analyze()}>{busy ? "正在解析…" : "使用当前服务解析"}</button>{result && <div className="vision-result"><b>{result.backendName} · {result.durationMs} ms{result.cached ? " · 缓存" : ""}</b><p>{result.text}</p></div>}</aside>
  </div>;
}

function McpFields({ backend, patchBackend, tools, discover }: { backend: McpVisionBackendConfig; patchBackend: (value: Partial<VisionBackendConfig>) => void; tools: string[]; discover: () => void }) {
  const patch = (value: Partial<McpVisionBackendConfig>) => patchBackend(value as Partial<VisionBackendConfig>);
  return <section className="form-section"><div className="section-heading"><h3>MCP 连接与映射</h3><button onClick={discover}>发现工具</button></div><div className="form-grid">
    <Field label="传输"><select value={backend.transport} onChange={(e) => patch(e.target.value === "stdio" ? { transport: "stdio", command: "npx", args: [], cwd: "", env: {}, envCredentialNames: {}, allowLocalPath: false } : { transport: "streamable-http", url: "http://127.0.0.1:3000/mcp", headers: {}, headerCredentialNames: {} })}><option value="stdio">stdio</option><option value="streamable-http">Streamable HTTP</option></select></Field>
    {backend.transport === "stdio" ? <><Field label="命令"><input value={backend.command} onChange={(e) => patch({ command: e.target.value })}/></Field><Field label="参数（每行一个）"><textarea value={backend.args.join("\n")} onChange={(e) => patch({ args: e.target.value.split("\n").filter(Boolean) })}/></Field><Field label="工作目录"><input value={backend.cwd} onChange={(e) => patch({ cwd: e.target.value })}/></Field><JsonRecordField label="环境变量（JSON）" value={backend.env} onChange={(env) => patch({ env })}/><JsonRecordField label="环境变量到凭据名称（JSON）" value={backend.envCredentialNames} onChange={(envCredentialNames) => patch({ envCredentialNames })}/></> : <><Field label="MCP URL"><input value={backend.url} onChange={(e) => patch({ url: e.target.value })}/></Field><JsonRecordField label="普通请求头（JSON）" value={backend.headers} onChange={(headers) => patch({ headers })}/><JsonRecordField label="请求头到凭据名称（JSON）" value={backend.headerCredentialNames} onChange={(headerCredentialNames) => patch({ headerCredentialNames })}/></>}
    <Field label="工具名称"><input list="mcp-tools" value={backend.toolName} onChange={(e) => patch({ toolName: e.target.value })}/><datalist id="mcp-tools">{tools.map((tool) => <option key={tool}>{tool}</option>)}</datalist></Field>
    <Field label="图片参数"><input value={backend.mapping.imageArgument} onChange={(e) => patch({ mapping: { ...backend.mapping, imageArgument: e.target.value } })}/></Field><Field label="图片格式"><select value={backend.mapping.imageEncoding} onChange={(e) => patch({ mapping: { ...backend.mapping, imageEncoding: e.target.value as "data-url" | "base64" | "path" } })}><option value="data-url">Data URL</option><option value="base64">Base64</option>{backend.transport === "stdio" && <option value="path">本机路径（需授权）</option>}</select></Field>
    <Field label="问题参数"><input value={backend.mapping.questionArgument ?? ""} onChange={(e) => patch({ mapping: { ...backend.mapping, questionArgument: e.target.value || null } })}/></Field><Field label="结果文字路径"><input value={backend.mapping.resultTextPath ?? ""} onChange={(e) => patch({ mapping: { ...backend.mapping, resultTextPath: e.target.value || null } })} placeholder="例如 structuredContent.description"/></Field>
    {backend.transport === "stdio" && backend.mapping.imageEncoding === "path" && <label className="check-field warning-check"><input type="checkbox" checked={backend.allowLocalPath} onChange={(e) => patch({ allowLocalPath: e.target.checked })}/>允许此本地进程读取图片绝对路径</label>}
  </div></section>;
}

function SettingsView({ info, setInfo }: { info: DesktopInfo | null; setInfo: (info: DesktopInfo) => void }) {
  const [credentialName, setCredentialName] = useState("DEEPSEEK_API_KEY"); const [credentialValue, setCredentialValue] = useState(""); const [message, setMessage] = useState("");
  const act = async (task: () => Promise<unknown>, success: string) => { try { setMessage("处理中…"); await task(); setInfo(await window.desktop.getInfo()); setMessage(success); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } };
  return <div className="single-feature"><header className="feature-header"><div><span className="eyebrow">DESKTOP CONTROL</span><h1>桌面设置</h1><p>{info?.unofficialNotice}</p></div></header>
    <section className="data-section"><h2>外观</h2><div className="theme-row">{(["light", "dark", "system"] as const).map((theme) => <button className={info?.themePreference === theme ? "active" : ""} key={theme} onClick={() => void act(() => window.desktop.setThemePreference(theme), "外观已更新")}>{theme === "light" ? "浅色" : theme === "dark" ? "深色" : "跟随系统"}</button>)}</div></section>
    <section className="data-section"><h2>运行状态</h2><div className="info-grid"><Summary label="桌面版本" value={info?.appVersion ?? "—"}/><Summary label="Harness" value={`${info?.harness.version ?? "—"} · ${info?.harness.status ?? "—"}`}/><Summary label="当前对话工作区" value={info?.activeWorkspacePath ?? "未打开工作区对话"}/><Summary label="数据目录" value={info?.userDataPath ?? "—"}/></div><div className="stack-actions horizontal"><button onClick={() => void act(() => window.desktop.restartHarness(), "Harness 已重启")}>重启 Harness</button><button onClick={() => void act(() => window.desktop.openLogs(), "日志目录已打开")}>打开日志</button></div></section>
    <section className="data-section"><h2>更新</h2><div className="settings-line"><select value={info?.updateChannel ?? "stable"} onChange={(event) => void act(() => window.desktop.setUpdateChannel(event.target.value as "stable" | "beta"), "更新通道已修改")}><option value="stable">Stable</option><option value="beta">Beta</option></select><button disabled={!info?.update.configured || info.update.phase === "checking"} onClick={() => void act(() => window.desktop.checkUpdate(), "桌面更新检查完成")}>检查桌面更新</button><button onClick={() => void act(() => window.desktop.checkHarnessUpdate(), "Harness 版本检查完成")}>检查 Harness</button>{info?.update.phase === "available" && <button onClick={() => void act(() => window.desktop.downloadUpdate(), "更新已下载")}>下载更新</button>}{info?.update.phase === "ready" && <button className="primary" onClick={() => void act(() => window.desktop.installUpdate(), "正在重启安装")}>安装更新</button>}</div><p className="muted">桌面：{info?.update.configured ? info.update.phase : "开发构建未配置更新源"} · Harness：{info?.harnessUpdate.phase}{info?.harnessUpdate.latestVersion ? ` · 最新 ${info.harnessUpdate.latestVersion}` : ""}</p></section>
    <section className="data-section"><h2>系统凭据</h2><p className="muted">凭据由操作系统加密保存，不会回显或写入日志。</p><div className="settings-line credential-line"><input value={credentialName} onChange={(event) => setCredentialName(event.target.value.toUpperCase())} placeholder="VISION_API_KEY"/><input type="password" value={credentialValue} onChange={(event) => setCredentialValue(event.target.value)} placeholder="API Key"/><button className="primary" onClick={() => void act(async () => { await window.desktop.setCredential(credentialName, credentialValue); setCredentialValue(""); }, "凭据已加密保存")}>保存</button><button onClick={() => void act(() => window.desktop.removeCredential(credentialName), "凭据已移除")}>移除</button></div></section>
    <div className="settings-message" role="status">{message}</div>
  </div>;
}

function Empty({ title, detail }: { title: string; detail: string }) { return <div className="empty"><span>⌁</span><h2>{title}</h2><p>{detail}</p></div>; }
function Summary({ label, value }: { label: string; value: string }) { return <div className="summary"><span>{label}</span><strong>{value}</strong></div>; }
function Field({ label, children }: React.PropsWithChildren<{ label: string }>) { return <label className="field"><span>{label}</span>{children}</label>; }
function JsonRecordField({ label, value, onChange }: { label: string; value: Record<string, string>; onChange: (value: Record<string, string>) => void }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2)); const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(JSON.stringify(value, null, 2)), [value]);
  return <Field label={label}><textarea className={invalid ? "invalid" : ""} value={text} onChange={(event) => setText(event.target.value)} onBlur={() => { try { const parsed = JSON.parse(text) as unknown; if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some((item) => typeof item !== "string")) throw new Error(); onChange(parsed as Record<string, string>); setInvalid(false); } catch { setInvalid(true); } }}/></Field>;
}

function App() {
  const query = new URLSearchParams(location.search); const initial = query.get("view") as View;
  const [view, setView] = useState<View>(WORKBENCH_VIEWS.has(initial) ? initial : "changes"); const [info, setInfo] = useState<DesktopInfo | null>(null); const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  useTheme(info); useEffect(() => { window.desktop.getInfo().then(setInfo); const offInfo = window.desktop.onInfoChanged(setInfo); const offNav = window.desktop.onWorkbenchNavigate((next) => { if (WORKBENCH_VIEWS.has(next as View)) setView(next as View); }); return () => { offInfo(); offNav(); }; }, []);
  const notify = (message: string, error = false) => { setToast({ message, error }); setTimeout(() => setToast(null), 4200); };
  const content = useMemo(() => view === "changes" ? <ChangesView notify={notify} workspacePath={info?.activeWorkspacePath ?? null}/> : view === "billing" ? <BillingView/> : view === "vision" ? <VisionView notify={notify}/> : <SettingsView info={info} setInfo={setInfo}/>, [view, info]);
  return <div className="app-shell"><nav className="activity-rail" aria-label="审阅与工具">{VIEWS.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)} title={item.label} aria-label={item.label}><span>{item.glyph}</span><small>{item.label}</small></button>)}<div className="rail-spacer"/><span className={`harness-led ${info?.harness.status === "ready" ? "ready" : ""}`} title={`Harness ${info?.harness.status ?? "starting"}`}/></nav><section className="workbench">{content}</section>{toast && <div className={`toast ${toast.error ? "error" : ""}`} role="status">{toast.message}</div>}</div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
