# Kaggle2API via Zeabur

> 将 Kaggle Notebook 的免费 AI 配额，通过 Cloudflare Tunnel + Zeabur 网关，转换为任意客户端可用的固定 OpenAI 兼容端点。

---

## 架构概览

```
你的客户端 (Cherry Studio / OpenAI SDK)
        ↓ 固定地址（永不变）
  Zeabur 网关服务（本仓库）
        ↓ 动态转发（注册机制）
  Kaggle Notebook → Cloudflare Tunnel（每次启动随机地址）
```

---

## 项目结构

```
Kaggle2API/
├── gateway/              # Zeabur 部署的转发网关
│   ├── server.js         # Express 反向代理 + 注册接口
│   └── package.json
└── notebook/             # 在 Kaggle 上运行的代码
    └── kaggle_proxy.py   # FastAPI 本地服务 + Cloudflare Tunnel + 自动注册
```

---

## 快速开始

### 1. 部署 Zeabur 网关

**Fork 本仓库**，然后在 [Zeabur](https://zeabur.com) 中：

1. `New Project` → `New Service` → `Git`，选择本仓库
2. 选择 `gateway/` 目录作为根目录（或在 Zeabur 设置 Root Directory 为 `gateway`）
3. 在 `Variables` 中添加环境变量：

```
REGISTRY_TOKEN=你自己设置的密钥（随意但要记住）
PORT=3000
```

4. 部署完成后，在 `Networking` 面板绑定域名或使用 Zeabur 提供的默认域名

记录你的网关地址，例如：
```
https://kaggle2api.zeabur.app
```

---

### 2. 在 Kaggle Notebook 运行代理

将 `notebook/kaggle_proxy.py` 的内容粘贴进 Kaggle Notebook 的 Code Cell，修改顶部两个变量：

```python
GATEWAY_URL = "https://kaggle2api.zeabur.app"   # 你的 Zeabur 网关地址
REGISTRY_TOKEN = "你设置的密钥"
```

运行后，Notebook 会：
1. 启动本地 FastAPI 代理服务（端口 8000）
2. 建立 Cloudflare Tunnel 获取临时公网地址
3. 自动将该地址注册到 Zeabur 网关

---

### 3. 配置客户端

在 Cherry Studio 或任何 OpenAI 兼容客户端中填写：

| 字段 | 值 |
|------|-----|
| API Base URL | `https://kaggle2api.zeabur.app/v1` |
| API Key | 任意非空字符串（如 `kaggle`） |

**这个地址永远不变。** 无论 Kaggle Notebook 重启多少次，只需重新运行 Notebook，网关会自动更新转发目标。

---

## 多账号负载均衡

同时运行多个 Kaggle 账号的 Notebook 时，网关会自动收集所有活跃节点并轮询转发。

查看当前活跃节点数：
```
GET https://kaggle2api.zeabur.app/status
```

返回示例：
```json
{
  "targets": [
    "https://abc123.trycloudflare.com",
    "https://def456.trycloudflare.com"
  ],
  "count": 2
}
```

---

## 支持的模型

网关透明转发，模型列表取决于 Kaggle 当前可用配额：

| 模型 ID | 说明 |
|---------|------|
| `google/gemini-2.0-flash` | 默认模型 |
| `anthropic/claude-sonnet-4-6@default` | Claude Sonnet |
| `anthropic/claude-opus-4-6@default` | Claude Opus |
| `deepseek-ai/deepseek-v3.1` | DeepSeek V3 |

获取完整列表：
```
GET https://kaggle2api.zeabur.app/v1/models
```

---

## 注意事项

- **Zeabur 免费计划**可能在长时间无请求后休眠容器，建议升级到付费计划或设置定时 ping 保活
- Kaggle Notebook 有运行时长限制（约 12 小时/次），到期需手动重启并重新运行代码
- `REGISTRY_TOKEN` 请勿泄露，任何持有该 token 的人都能向网关注册转发目标

---

## License

MIT
