const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const https = require('https');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());

const AUTH_TOKEN = process.env.REGISTRY_TOKEN || 'your-secret-token';
const DEPLOY_HOOK = process.env.ZEABUR_DEPLOY_HOOK || '';
const REPO = 'Akatsuki03/Kaggle2API-via-Zeabur';
const LOCAL_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8'));

let nodes = [];
let roundRobin = 0;
let globalStats = { totalRequests: 0, totalErrors: 0, startTime: Date.now() };
let updateCache = { data: null, checkedAt: 0 };

// === 工具函数 ===
function fetchText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Kaggle2API' } }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

function compareVersion(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] > pb[i]) return 1;
        if (pa[i] < pb[i]) return -1;
    }
    return 0;
}

// === 注册与状态 (后端API) ===
app.post('/register', (req, res) => {
    const { token, endpoint, label } = req.body;
    if (token !== AUTH_TOKEN) return res.status(403).json({ error: 'forbidden' });

    const existing = nodes.find(n => n.endpoint === endpoint);
    if (existing) {
        existing.lastSeen = Date.now();
        return res.json({ ok: true, msg: 'refreshed', total: nodes.length });
    }

    nodes.push({
        endpoint,
        label: label || `Node-${nodes.length + 1}`,
        registeredAt: Date.now(),
        lastSeen: Date.now(),
        requests: 0,
        errors: 0,
        lastUsed: null
    });

    console.log(`✅ 注册: ${endpoint} | 节点数: ${nodes.length}`);
    res.json({ ok: true, total: nodes.length });
});

app.post('/unregister', (req, res) => {
    const { token, endpoint } = req.body;
    if (token !== AUTH_TOKEN) return res.status(403).json({ error: 'forbidden' });
    nodes = nodes.filter(n => n.endpoint !== endpoint);
    res.json({ ok: true, total: nodes.length });
});

app.get('/status', (req, res) => {
    const uptime = Math.floor((Date.now() - globalStats.startTime) / 1000);
    res.json({
        uptime,
        version: LOCAL_VERSION.version,
        totalRequests: globalStats.totalRequests,
        totalErrors: globalStats.totalErrors,
        nodes: nodes.map(n => ({
            label: n.label,
            endpoint: n.endpoint,
            requests: n.requests,
            errors: n.errors,
            registeredAt: n.registeredAt,
            lastSeen: n.lastSeen,
            lastUsed: n.lastUsed
        }))
    });
});

// === 更新检查 (后端API) ===
app.get('/api/check-update', async (req, res) => {
    try {
        const now = Date.now();
        if (updateCache.data && (now - updateCache.checkedAt) < 60000) {
            return res.json(updateCache.data);
        }

        const versionUrl = `https://raw.githubusercontent.com/${REPO}/main/gateway/version.json?t=${now}`;
        const changelogUrl = `https://raw.githubusercontent.com/${REPO}/main/CHANGELOG.md?t=${now}`;

        let remoteVersionStr = '';
        try {
             remoteVersionStr = await fetchText(versionUrl);
        } catch(e) {
             throw new Error("无法连接到 Github 仓库获取版本信息");
        }
        
        if (!remoteVersionStr || remoteVersionStr.includes("404: Not Found")) {
             throw new Error("未在远程仓库找到 version.json，可能刚推送，请稍后刷新");
        }

        let remoteVersion;
        try {
             remoteVersion = JSON.parse(remoteVersionStr);
        } catch(e) {
             throw new Error("远程版本文件格式错误");
        }

        let changelog = '';
        try {
            changelog = await fetchText(changelogUrl);
            if(changelog.includes("404: Not Found")) changelog = '';
        } catch(e) {
             changelog = '';
        }

        const hasUpdate = compareVersion(remoteVersion.version, LOCAL_VERSION.version) > 0;

        const result = {
            current: LOCAL_VERSION.version,
            currentDate: LOCAL_VERSION.date,
            remote: remoteVersion.version,
            remoteDate: remoteVersion.date,
            hasUpdate,
            changelog,
            deployHookConfigured: !!DEPLOY_HOOK
        };

        updateCache = { data: result, checkedAt: now };
        res.json(result);
    } catch(e) {
        console.error("更新检查错误:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/update', (req, res) => {
    const { token } = req.body;
    if (token !== AUTH_TOKEN) return res.status(403).json({ error: 'forbidden' });

    if (!DEPLOY_HOOK) {
        return res.json({ 
            ok: true, 
            status: 200, 
            response: '已开启 GitHub 自动部署或未配置免密更新。\n如果您是通过 GitHub 绑定的 Zeabur，拉取最新代码 (Sync fork) 后 Zeabur 会自动部署。' 
        });
    }

    const url = new URL(DEPLOY_HOOK);
    const reqOpt = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Kaggle2API' }
    };

    const hookReq = https.request(reqOpt, (hookRes) => {
        let body = '';
        hookRes.on('data', c => body += c);
        hookRes.on('end', () => {
            console.log(`🔄 Deploy hook 已触发，状态: ${hookRes.statusCode}`);
            res.json({ ok: true, status: hookRes.statusCode, response: body });
        });
    });

    hookReq.on('error', (e) => res.status(500).json({ error: e.message }));
    hookReq.end();
});

// === 轮询转发核心 ===
app.use('/v1', (req, res) => {
    if (nodes.length === 0) {
        return res.status(503).json({ error: '没有活跃的Kaggle节点' });
    }

    const node = nodes[roundRobin % nodes.length];
    roundRobin++;
    node.lastUsed = Date.now();
    node.requests++;
    globalStats.totalRequests++;

    console.log(`🔄 → ${node.label} (${node.endpoint})`);

    createProxyMiddleware({
        target: node.endpoint,
        changeOrigin: true,
        on: {
            error: (err) => {
                node.errors++;
                globalStats.totalErrors++;
                console.error(`💀 ${node.label} 失败: ${err.message}`);
                nodes = nodes.filter(n => n.endpoint !== node.endpoint);
                res.status(502).json({ error: '节点断开，已自动移除' });
            }
        }
    })(req, res, () => {});
});

// === 仪表盘 GUI (包含正确的字符串拼接) ===
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kaggle2API Dashboard</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #0a0e17; color: #c9d1d9; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #161b22 0%, #0d1117 100%); border-bottom: 1px solid #21262d; padding: 20px 32px; display: flex; align-items: center; justify-content: space-between; }
    .header-left { display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 20px; font-weight: 600; color: #e6edf3; }
    .header h1 span { color: #58a6ff; }
    .version-badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #1f2937; border: 1px solid #30363d; color: #8b949e; }
    .header-right { display: flex; align-items: center; gap: 16px; }
    .header-status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #8b949e; }
    .pulse { width: 8px; height: 8px; background: #3fb950; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(63,185,80,0.4); } 50% { opacity: 0.8; box-shadow: 0 0 0 6px rgba(63,185,80,0); } }
    .container { max-width: 960px; margin: 0 auto; padding: 24px; }
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
    .stat-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; }
    .stat-card .label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .stat-card .value { font-size: 28px; font-weight: 700; color: #e6edf3; }
    .stat-card .value.blue { color: #58a6ff; } .stat-card .value.green { color: #3fb950; } .stat-card .value.orange { color: #d29922; } .stat-card .value.red { color: #f85149; }
    .section-title { font-size: 14px; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
    .node-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
    .node-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px 20px; display: flex; align-items: center; gap: 16px; transition: border-color 0.2s; }
    .node-card:hover { border-color: #388bfd; }
    .node-indicator { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .node-indicator.alive { background: #3fb950; } .node-indicator.stale { background: #d29922; } .node-indicator.dead { background: #f85149; }
    .node-info { flex: 1; min-width: 0; }
    .node-label { font-size: 14px; font-weight: 600; color: #e6edf3; margin-bottom: 2px; }
    .node-endpoint { font-size: 12px; color: #8b949e; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .node-metrics { display: flex; gap: 20px; flex-shrink: 0; }
    .metric { text-align: right; } .metric .num { font-size: 16px; font-weight: 600; color: #e6edf3; } .metric .tag { font-size: 11px; color: #8b949e; }
    .empty-state { text-align: center; padding: 48px; color: #484f58; } .empty-state .icon { font-size: 36px; margin-bottom: 12px; }
    .update-panel { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
    .update-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .update-title { display: flex; align-items: center; gap: 10px; }
    .update-title h3 { font-size: 15px; font-weight: 600; color: #e6edf3; }
    .badge { font-size: 11px; padding: 2px 10px; border-radius: 12px; font-weight: 600; }
    .badge.latest { background: rgba(63,185,80,0.15); color: #3fb950; border: 1px solid rgba(63,185,80,0.3); }
    .badge.available { background: rgba(210,153,34,0.15); color: #d29922; border: 1px solid rgba(210,153,34,0.3); animation: glow 2s infinite; }
    @keyframes glow { 0%, 100% { box-shadow: none; } 50% { box-shadow: 0 0 8px rgba(210,153,34,0.3); } }
    .badge.checking { background: rgba(88,166,255,0.15); color: #58a6ff; border: 1px solid rgba(88,166,255,0.3); }
    .badge.error { background: rgba(248,81,73,0.15); color: #f85149; border: 1px solid rgba(248,81,73,0.3); }
    .update-actions { display: flex; gap: 8px; }
    .btn { padding: 6px 16px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; font-size: 13px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 6px; }
    .btn:hover { background: #30363d; border-color: #484f58; }
    .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; } .btn.primary:hover { background: #388bfd; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn .spinner { width: 12px; height: 12px; border: 2px solid transparent; border-top-color: currentColor; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .version-info { display: flex; gap: 24px; margin-bottom: 16px; }
    .ver-item { font-size: 13px; color: #8b949e; } .ver-item strong { color: #e6edf3; }
    .changelog-box { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 16px; max-height: 240px; overflow-y: auto; font-size: 13px; line-height: 1.7; color: #8b949e; display: none; }
    .changelog-box.show { display: block; }
    .changelog-box h2 { font-size: 15px; color: #e6edf3; margin: 12px 0 6px 0; } .changelog-box h2:first-child { margin-top: 0; }
    .changelog-box h3 { font-size: 13px; color: #d29922; margin: 8px 0 4px 0; }
    .changelog-box ul { padding-left: 20px; } .changelog-box li { margin: 2px 0; }
    .changelog-toggle { font-size: 12px; color: #58a6ff; cursor: pointer; margin-top: 8px; display: inline-block; } .changelog-toggle:hover { text-decoration: underline; }
    .update-msg { margin-top: 12px; font-size: 13px; padding: 8px 12px; border-radius: 6px; display: none; }
    .update-msg.info { display: block; background: rgba(88,166,255,0.1); color: #58a6ff; }
    .update-msg.success { display: block; background: rgba(63,185,80,0.1); color: #3fb950; }
    .update-msg.err { display: block; background: rgba(248,81,73,0.1); color: #f85149; }
    .footer { text-align: center; margin-top: 32px; padding: 16px; font-size: 12px; color: #484f58; } .footer a { color: #58a6ff; text-decoration: none; }
    @media (max-width: 640px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } .node-metrics { gap: 12px; } .version-info { flex-direction: column; gap: 4px; } .update-header { flex-direction: column; align-items: flex-start; gap: 12px; } }
</style>
</head>
<body>

<div class="header">
    <div class="header-left">
        <h1><span>Kaggle2API</span> Dashboard</h1>
        <span class="version-badge" id="header-ver">v${LOCAL_VERSION.version}</span>
    </div>
    <div class="header-right">
        <div class="header-status">
            <div class="pulse"></div>
            <span id="uptime">--</span>
        </div>
    </div>
</div>

<div class="container">
    <div class="stats-grid">
        <div class="stat-card"><div class="label">活跃节点</div><div class="value green" id="s-nodes">0</div></div>
        <div class="stat-card"><div class="label">总请求数</div><div class="value blue" id="s-requests">0</div></div>
        <div class="stat-card"><div class="label">总失败数</div><div class="value red" id="s-errors">0</div></div>
        <div class="stat-card"><div class="label">成功率</div><div class="value orange" id="s-rate">--</div></div>
    </div>

    <div class="section-title">版本管理</div>
    <div class="update-panel">
        <div class="update-header">
            <div class="update-title">
                <h3>🔧 系统更新</h3>
                <span class="badge checking" id="update-badge">检查中...</span>
            </div>
            <div class="update-actions">
                <button class="btn" id="btn-check" onclick="checkUpdate()">🔍 检查更新</button>
                <button class="btn primary" id="btn-update" style="display:none" onclick="doUpdate()">🚀 立即更新</button>
            </div>
        </div>
        <div class="version-info">
            <div class="ver-item">当前版本: <strong id="ver-current">v${LOCAL_VERSION.version}</strong></div>
            <div class="ver-item">发布日期: <strong id="ver-current-date">${LOCAL_VERSION.date}</strong></div>
            <div class="ver-item" id="ver-remote-wrap" style="display:none">最新版本: <strong id="ver-remote">--</strong></div>
        </div>
        <span class="changelog-toggle" id="cl-toggle" style="display:none" onclick="toggleChangelog()">📋 查看更新日志</span>
        <div class="changelog-box" id="changelog"></div>
        <div class="update-msg" id="update-msg"></div>
    </div>

    <div class="section-title">节点列表</div>
    <div class="node-list" id="node-list">
        <div class="empty-state"><div class="icon">📡</div><p>等待 Kaggle 节点注册...</p></div>
    </div>
</div>

<div class="footer">
    <a href="https://github.com/${REPO}" target="_blank">GitHub</a>
    &nbsp;·&nbsp; 每 3 秒自动刷新
</div>

<script>
function formatUptime(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + '时 ' + m + '分';
    if (m > 0) return m + '分 ' + s + '秒';
    return s + '秒';
}

function timeAgo(ts) {
    if (!ts) return '--';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return diff + '秒前';
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    return Math.floor(diff / 3600) + '小时前';
}

function nodeStatus(lastSeen) {
    const diff = Date.now() - lastSeen;
    if (diff < 120000) return 'alive';
    if (diff < 600000) return 'stale';
    return 'dead';
}

async function refresh() {
    try {
        const res = await fetch('/status');
        const d = await res.json();
        document.getElementById('uptime').textContent = '运行 ' + formatUptime(d.uptime);
        document.getElementById('s-nodes').textContent = d.nodes.length;
        document.getElementById('s-requests').textContent = d.totalRequests;
        document.getElementById('s-errors').textContent = d.totalErrors;
        const total = d.totalRequests;
        document.getElementById('s-rate').textContent = total > 0 ? ((total - d.totalErrors) / total * 100).toFixed(1) + '%' : '--';

        const list = document.getElementById('node-list');
        if (d.nodes.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="icon">📡</div><p>等待 Kaggle 节点注册...</p></div>';
            return;
        }
        list.innerHTML = d.nodes.map(n => {
            return '<div class="node-card"><div class="node-indicator ' + nodeStatus(n.lastSeen) + '"></div><div class="node-info"><div class="node-label">' + n.label + '</div><div class="node-endpoint">' + n.endpoint + '</div></div><div class="node-metrics"><div class="metric"><div class="num">' + n.requests + '</div><div class="tag">请求</div></div><div class="metric"><div class="num">' + n.errors + '</div><div class="tag">失败</div></div><div class="metric"><div class="num">' + timeAgo(n.lastUsed) + '</div><div class="tag">最近使用</div></div></div></div>';
        }).join('');
    } catch(e) {}
}

async function checkUpdate() {
    const badge = document.getElementById('update-badge'), btn = document.getElementById('btn-check');
    const btnUpdate = document.getElementById('btn-update'), msg = document.getElementById('update-msg');
    
    badge.className = 'badge checking'; badge.textContent = '检查中...';
    btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> 检查中';
    btnUpdate.style.display = 'none'; msg.className = 'update-msg';

    try {
        const res = await fetch('/api/check-update');
        const d = await res.json();
        if (d.error) throw new Error(d.error);

        document.getElementById('ver-current').textContent = 'v' + d.current;
        document.getElementById('ver-current-date').textContent = d.currentDate;

        if (d.hasUpdate) {
            badge.className = 'badge available'; badge.textContent = 'v' + d.remote + ' 可用';
            document.getElementById('ver-remote-wrap').style.display = '';
            document.getElementById('ver-remote').textContent = 'v' + d.remote + ' (' + d.remoteDate + ')';
            
            if (!d.deployHookConfigured) {
                btnUpdate.style.display = 'none';
                msg.className = 'update-msg info';
                msg.textContent = '💡 提示：Zeabur 正在监听 GitHub 仓库自动部署。若是 Fork 的项目，请前往 GitHub 点击 "Sync fork" 拉取最新代码即可自动升级。';
            } else {
                btnUpdate.style.display = '';
            }
        } else {
            badge.className = 'badge latest'; badge.textContent = '已是最新';
        }

        if (d.changelog) {
            document.getElementById('cl-toggle').style.display = '';
            // 修复可能出现的正则转义问题
            let out = d.changelog.replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h2>$1</h2>').replace(/^- (.+)$/gm, '<li>$1</li>');
            out = out.split('\\n').join('<br>').split('\\r').join('');
            document.getElementById('changelog').innerHTML = out;
        }
    } catch(e) {
        badge.className = 'badge error'; badge.textContent = '检查失败';
        msg.className = 'update-msg err'; msg.textContent = '❌ ' + e.message;
    }
    btn.disabled = false; btn.innerHTML = '🔍 检查更新';
}

async function doUpdate() {
    const token = prompt('输入管理密钥 (REGISTRY_TOKEN):');
    if (!token) return;
    const btn = document.getElementById('btn-update'), msg = document.getElementById('update-msg');
    btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> 部署中...';
    try {
        const res = await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        msg.className = 'update-msg success'; msg.textContent = '✅ 部署已触发！Zeabur 正在重新构建，页面将自动刷新...';
        setTimeout(() => location.reload(), 30000);
    } catch(e) {
        msg.className = 'update-msg err'; msg.textContent = '❌ ' + e.message;
        btn.disabled = false; btn.innerHTML = '🚀 立即更新';
    }
}

function toggleChangelog() {
    const box = document.getElementById('changelog'), toggle = document.getElementById('cl-toggle');
    box.classList.toggle('show');
    toggle.textContent = box.classList.contains('show') ? '📋 收起更新日志' : '📋 查看更新日志';
}

refresh(); setInterval(refresh, 3000); setTimeout(checkUpdate, 1000);
</script>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, () => {
    console.log('🚀 Kaggle2API Gateway v' + LOCAL_VERSION.version + ' 已启动');
});