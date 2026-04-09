const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

app.use(express.json());

const AUTH_TOKEN = process.env.REGISTRY_TOKEN || 'your-secret-token';

let nodes = [];
let roundRobin = 0;
let globalStats = { totalRequests: 0, totalErrors: 0, startTime: Date.now() };

// === 注册 ===
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

// === 移除 ===
app.post('/unregister', (req, res) => {
    const { token, endpoint } = req.body;
    if (token !== AUTH_TOKEN) return res.status(403).json({ error: 'forbidden' });
    nodes = nodes.filter(n => n.endpoint !== endpoint);
    res.json({ ok: true, total: nodes.length });
});

// === 状态 API ===
app.get('/status', (req, res) => {
    const uptime = Math.floor((Date.now() - globalStats.startTime) / 1000);
    res.json({
        uptime,
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

// === 仪表盘 ===
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kaggle2API Dashboard</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        background: #0a0e17;
        color: #c9d1d9;
        min-height: 100vh;
    }

    .header {
        background: linear-gradient(135deg, #161b22 0%, #0d1117 100%);
        border-bottom: 1px solid #21262d;
        padding: 20px 32px;
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .header h1 {
        font-size: 20px;
        font-weight: 600;
        color: #e6edf3;
    }

    .header h1 span { color: #58a6ff; }

    .header-status {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: #8b949e;
    }

    .pulse {
        width: 8px; height: 8px;
        background: #3fb950;
        border-radius: 50%;
        animation: pulse 2s infinite;
    }

    @keyframes pulse {
        0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(63,185,80,0.4); }
        50% { opacity: 0.8; box-shadow: 0 0 0 6px rgba(63,185,80,0); }
    }

    .container { max-width: 960px; margin: 0 auto; padding: 24px; }

    .stats-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
        margin-bottom: 24px;
    }

    .stat-card {
        background: #161b22;
        border: 1px solid #21262d;
        border-radius: 8px;
        padding: 16px;
    }

    .stat-card .label {
        font-size: 12px;
        color: #8b949e;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
    }

    .stat-card .value {
        font-size: 28px;
        font-weight: 700;
        color: #e6edf3;
    }

    .stat-card .value.blue { color: #58a6ff; }
    .stat-card .value.green { color: #3fb950; }
    .stat-card .value.orange { color: #d29922; }
    .stat-card .value.red { color: #f85149; }

    .section-title {
        font-size: 14px;
        font-weight: 600;
        color: #8b949e;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 12px;
    }

    .node-list { display: flex; flex-direction: column; gap: 8px; }

    .node-card {
        background: #161b22;
        border: 1px solid #21262d;
        border-radius: 8px;
        padding: 16px 20px;
        display: flex;
        align-items: center;
        gap: 16px;
        transition: border-color 0.2s;
    }

    .node-card:hover { border-color: #388bfd; }

    .node-indicator {
        width: 10px; height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .node-indicator.alive { background: #3fb950; }
    .node-indicator.stale { background: #d29922; }
    .node-indicator.dead { background: #f85149; }

    .node-info { flex: 1; min-width: 0; }

    .node-label {
        font-size: 14px;
        font-weight: 600;
        color: #e6edf3;
        margin-bottom: 2px;
    }

    .node-endpoint {
        font-size: 12px;
        color: #8b949e;
        font-family: monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .node-metrics {
        display: flex;
        gap: 20px;
        flex-shrink: 0;
    }

    .metric {
        text-align: right;
    }

    .metric .num {
        font-size: 16px;
        font-weight: 600;
        color: #e6edf3;
    }

    .metric .tag {
        font-size: 11px;
        color: #8b949e;
    }

    .empty-state {
        text-align: center;
        padding: 48px;
        color: #484f58;
    }

    .empty-state .icon { font-size: 36px; margin-bottom: 12px; }
    .empty-state p { font-size: 14px; }

    .footer {
        text-align: center;
        margin-top: 32px;
        padding: 16px;
        font-size: 12px;
        color: #484f58;
    }

    .footer a { color: #58a6ff; text-decoration: none; }

    @media (max-width: 640px) {
        .stats-grid { grid-template-columns: repeat(2, 1fr); }
        .node-metrics { gap: 12px; }
    }
</style>
</head>
<body>

<div class="header">
    <h1><span>Kaggle2API</span> Dashboard</h1>
    <div class="header-status">
        <div class="pulse"></div>
        <span id="uptime">--</span>
    </div>
</div>

<div class="container">
    <div class="stats-grid">
        <div class="stat-card">
            <div class="label">活跃节点</div>
            <div class="value green" id="s-nodes">0</div>
        </div>
        <div class="stat-card">
            <div class="label">总请求数</div>
            <div class="value blue" id="s-requests">0</div>
        </div>
        <div class="stat-card">
            <div class="label">总失败数</div>
            <div class="value red" id="s-errors">0</div>
        </div>
        <div class="stat-card">
            <div class="label">成功率</div>
            <div class="value orange" id="s-rate">--</div>
        </div>
    </div>

    <div class="section-title">节点列表</div>
    <div class="node-list" id="node-list">
        <div class="empty-state">
            <div class="icon">📡</div>
            <p>等待 Kaggle 节点注册...</p>
        </div>
    </div>
</div>

<div class="footer">
    <a href="https://github.com/Akatsuki03/Kaggle2API-via-Zeabur" target="_blank">GitHub</a>
    &nbsp;·&nbsp; 每 3 秒自动刷新
</div>

<script>
function formatUptime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
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
        const rate = total > 0 ? ((total - d.totalErrors) / total * 100).toFixed(1) + '%' : '--';
        document.getElementById('s-rate').textContent = rate;

        const list = document.getElementById('node-list');

        if (d.nodes.length === 0) {
            list.innerHTML = '<div class="empty-state"><div class="icon">📡</div><p>等待 Kaggle 节点注册...</p></div>';
            return;
        }

        list.innerHTML = d.nodes.map(n => {
            const st = nodeStatus(n.lastSeen);
            return '<div class="node-card">'
                + '<div class="node-indicator ' + st + '"></div>'
                + '<div class="node-info">'
                + '<div class="node-label">' + n.label + '</div>'
                + '<div class="node-endpoint">' + n.endpoint + '</div>'
                + '</div>'
                + '<div class="node-metrics">'
                + '<div class="metric"><div class="num">' + n.requests + '</div><div class="tag">请求</div></div>'
                + '<div class="metric"><div class="num">' + n.errors + '</div><div class="tag">失败</div></div>'
                + '<div class="metric"><div class="num">' + timeAgo(n.lastUsed) + '</div><div class="tag">最近使用</div></div>'
                + '</div></div>';
        }).join('');
    } catch(e) {}
}

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`);
});

// === 轮询转发 ===
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

app.listen(process.env.PORT || 3000, () => {
    console.log('🚀 Kaggle2API Gateway 已启动');
});