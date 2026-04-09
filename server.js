// server.js
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

app.use(express.json());

let currentTarget = null;
const AUTH_TOKEN = process.env.REGISTRY_TOKEN || 'your-secret-token';

// Kaggle Notebook启动时来这里注册
app.post('/register', (req, res) => {
    const { token, endpoint } = req.body;
    if (token !== AUTH_TOKEN) {
        return res.status(403).json({ error: 'forbidden' });
    }
    currentTarget = endpoint;
    console.log(`✅ 新端点注册: ${endpoint}`);
    res.json({ ok: true });
});

// 查看当前状态
app.get('/status', (req, res) => {
    res.json({ target: currentTarget, alive: !!currentTarget });
});

// 转发所有/v1请求
app.use('/v1', (req, res, next) => {
    if (!currentTarget) {
        return res.status(503).json({ error: '没有活跃的Kaggle节点' });
    }
    createProxyMiddleware({
        target: currentTarget,
        changeOrigin: true,
        pathRewrite: { '^/v1': '/v1' },
        on: {
            error: (err) => {
                console.error('转发失败:', err.message);
                res.status(502).json({ error: '转发失败，Kaggle节点可能已断开' });
            }
        }
    })(req, res, next);
});

app.listen(process.env.PORT || 3000, () => {
    console.log('🚀 网关已启动');
});
