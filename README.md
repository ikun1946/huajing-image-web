# 画境 · Magpie 生图（前后端分离）

单张生图工作台 + 资产批量工作台。后端是纯 API（Fastify + TypeScript），前端是 Vite 承载的原生 ES Module，两者独立运行、独立部署。

## 目录结构

```text
huajing-image-web/
├── server/                    后端：只提供 API，不托管页面
│   ├── src/
│   │   ├── index.ts           启动、路由装配、CORS、错误处理
│   │   ├── config.ts          环境变量与画面比例定义（唯一来源）
│   │   ├── routes/
│   │   │   ├── images.ts      POST /api/images
│   │   │   ├── files.ts       GET  /api/files/*
│   │   │   ├── meta.ts        GET  /api/config、/api/health
│   │   │   ├── auth.ts        登录、登入、当前用户、首次引导
│   │   │   ├── admin.ts       账号管理、生成统计
│   │   │   ├── projects.ts    项目增删改查
│   │   │   └── styles.ts      风格库读写
│   │   ├── services/
│   │   │   ├── magpie.js      调上游 Magpie 生图接口
│   │   │   ├── imaging.ts     图片格式探测、像素尺寸读取
│   │   │   ├── storage.ts     存储抽象（本地盘，日后可换对象存储）
│   │   │   ├── user-store.ts  账号库
│   │   │   ├── usage-store.ts 生图统计
│   │   │   ├── project-store.ts 项目库
│   │   │   └── style-library.ts 风格库
│   │   └── lib/
│   │       ├── errors.ts      统一错误码
│   │       ├── serial-gate.ts 全局串行闸门
│   │       ├── session.ts     会话表
│   │       └── password.ts    scrypt 密码哈希
│   ├── package.json
│   └── .env.example
├── web/                       前端：只管渲染与交互
│   ├── index.html             单张工作台
│   ├── batch.html             资产批量工作台
│   ├── login.html             登录页（无注册入口）
│   ├── admin.html             后台管理页
│   ├── src/
│   │   ├── lib/               api.js / config.js / dom.js / guard.js
│   │   ├── index/             单张工作台 CSS + JS
│   │   ├── batch/             批量工作台 CSS + JS
│   │   ├── login/             登录页 JS
│   │   └── admin/             管理页 CSS + JS
│   ├── vite.config.ts
│   └── package.json
├── scripts/dev.mjs            一条命令同时起前后端
├── 启动后端.bat                一键启动（双击）
├── 停止服务.bat                一键停止（双击）
├── users.json                 账号库
├── projects.json              项目库（每个项目一份独立的资产数据）
├── usage.json                 生图统计
├── styles.json                风格库
├── server.log                 后端运行日志
└── generated/                 生成的图片（按资产类型分文件夹）
    ├── 角色/                   角色资产图，文件名为资产名
    ├── 场景/                   场景资产图
    ├── 道具/                   道具资产图
    ├── 自由创作/                批量页的自由创作
    └── 单张创作/                单张工作台
```

## 启动

### 一键启动（推荐）

双击项目根目录的 **`启动后端.bat`**（或 `start-server.bat`），启动器会自动完成：

1. **环境体检** — 检查 Node.js 版本，缺失时给出安装命令
2. **依赖补齐** — 后端/前端依赖未安装时自动 `npm install`
3. **构建** — 产物缺失或指定 `--rebuild` 时自动构建前后端
4. **拉起 Magpie** — 上游未运行时自动从 `MAGPIE_EXE` 或 `~/Downloads` 启动
5. **端口检查** — 端口被占用时给出提示而不是抛错
6. **打开浏览器** — 服务就绪后自动打开单张工作台

启动器窗口会在服务就绪后自动关闭，**服务在后台继续运行**。
运行日志写入 `server.log`，出问题先看它。要停止服务，双击 **`停止服务.bat`**。

> `.bat` 里的脚本路径用正斜杠并加引号（`node "scripts/launch-server.mjs"`），
> 否则 cmd 会吞掉反斜杠导致找不到模块。

也可以在命令行使用：

```powershell
npm run start:server              # 正常启动
npm run start:server:rebuild      # 强制重新构建前后端
npm run start:server:dev         # 开发模式，热重载
node scripts/launch-server.mjs --no-open     # 不自动打开浏览器
node scripts/launch-server.mjs --no-magpie   # 不自动拉起 Magpie
```

启动器会读取 `server/.env`（若存在），其中的 `PORT`、`MAGPIE_BASE_URL`、`MAGPIE_EXE` 等配置优先于默认值。

### 手动启动

```powershell
npm run install:all
npm run dev
```

- 前端：http://127.0.0.1:5173
- 后端：http://127.0.0.1:8787

生产构建（前端产物由后端直接托管）：

```powershell
npm run build
npm start
```

## 接口契约

```text
POST /api/images
  请求  { prompt, ratio, category, name, source }   需要登录
  成功  { id, imageUrl, model, mimeType, bytes, width, height, ratio }
  失败  { error, code }

GET  /api/config      画面比例、原生尺寸、提示词上限、默认值
GET  /api/health      后端与上游 Magpie 的连通状态
GET  /api/queue       串行闸门状态：{ busy, waiting }
GET  /api/files/*     生成图片（支持 类别/文件名 与旧版 UUID 两种形式）

GET    /api/projects            项目列表 { projects, activeProjectId }
GET    /api/projects/:id        项目详情
POST   /api/projects            新建项目 { name?, fileName? }
PATCH  /api/projects/:id        更新项目 { name?, assets?, styles?, defaultStyle?, bulkParams? }
DELETE /api/projects/:id        删除项目
POST   /api/projects/:id/activate  设为当前项目

POST /api/auth/login   登录 { username, password } → { user }
POST /api/auth/logout  登出
GET  /api/auth/me      当前登录用户
GET  /api/auth/status  账号库是否为空（登录页用）
POST /api/auth/setup   引导创建首个管理员（需管理密钥，且账号库为空）

GET    /api/admin/users   账号列表            管理员
POST   /api/admin/users   新建账号            管理员
PATCH  /api/admin/users/:id  改显示名/密码/启停  管理员
DELETE /api/admin/users/:id  删除账号          管理员
GET    /api/admin/stats   生图统计            管理员
```

错误码：`INVALID_PROMPT`、`PROMPT_TOO_LONG`、`RATIO_INVALID`、`AUTH_REQUIRED`、`AUTH_INVALID`、`AUTH_FORBIDDEN`、`UPSTREAM_UNREACHABLE`、`UPSTREAM_TIMEOUT`、`UPSTREAM_ERROR`、`UPSTREAM_BAD_RESPONSE`、`IMAGE_INVALID`、`IMAGE_UNSUPPORTED`、`INTERNAL_ERROR`。

`imageUrl` 是后端绝对地址（依据 `PUBLIC_BASE_URL` 或请求 Host 推断），因此前端部署在任何端口都能正确取图。

### 图片落盘规则

生成后自动存到本地 `generated/`，**按资产类型分文件夹，文件名用资产名**：

```text
generated/
├── 角色/苏晚棠-1086x1448.png
├── 场景/潇湘馆正厅-1672x941.png
├── 道具/青霜剑-1254x1254.png
├── 自由创作/自由创作-20261025-110448-1254x1254.png
└── 单张创作/单张-20261025-143052-1254x1254.png
```

- 文件名主体是资产名，后缀是实际像素尺寸，方便肉眼核对画幅。
- 同名资产重复生成不会互相覆盖，自动加 `-2`、`-3` 序号。
- 资产名里的 Windows 保留字符（`< > : " / \ | ? *`）会被替换成下划线，`..` 等路径片段也会被清洗，杜绝越权写入。
- 需要改存储位置就设 `STORAGE_DIR` 环境变量（见 `server/.env.example`）。

## 画面比例与输出尺寸

画幅只在后端 `server/src/config.ts` 定义一次，前端通过 `/api/config` 动态渲染，不再硬编码两遍。

| 画幅 | 上游原生输出 | 比例偏差 |
| --- | --- | ---: |
| `1:1` | 1254 × 1254 | 0.000% |
| `4:3` | 1448 × 1086 | 0.000% |
| `3:4` | 1086 × 1448 | 0.000% |
| `16:9` | 1672 × 941 | -0.053% |
| `9:16` | 941 × 1672 | 0.053% |

处理方式：

- **画幅靠提示词锁定**。服务端把「画面比例 16:9，宽银幕横向构图，宽幅画幅」这类描述追加到提示词末尾，上游会按此构图。
- **尺寸直接交付原图**。上游按画幅输出的原生尺寸已足够准确，因此不做任何缩放、裁切或补边，交付的就是上游原图。

同一提示词重复生成三次，输出尺寸完全稳定（1:1 恒为 `1254×1254`，16:9 恒为 `1672×941`），
说明尺寸由模型内部按画幅固定。接口返回的 `width` / `height` 取自图片文件头读取的真实像素，
而不是配置里的声明值。

### 为什么没有分辨率选项

上游**不认任何尺寸参数，也不认提示词里的分辨率描述**。Magpie 的 `/v1/images/generations`
会把请求体原样透传给上游，以下调用全部返回**同一尺寸**，说明参数被直接忽略：

| 调用方式 | 实际输出 |
| --- | --- |
| 不传任何参数 | 1312 × 1199 |
| `size: "1024x1024"` | 1312 × 1199 |
| `size: "2048x2048"` | 1312 × 1199 |
| `quality: "high"` | 1312 × 1199 |
| `quality: "hd"` | 1312 × 1199 |
| `size` + `quality` 组合 | 1374 × 1145 |
| `output_format` / `response_format` | 1374 × 1145 |

提示词层面同样无效，以 1:1 为主体追加十种分辨率写法，输出尺寸**全部是 `1254×1254`**：

| 提示词追加内容 | 实际输出 |
| --- | --- |
| （不追加，仅写比例） | 1254 × 1254 |
| `输出分辨率 1024x1024` | 1254 × 1254 |
| `输出分辨率 2048x2048` | 1254 × 1254 |
| `输出分辨率 4096x4096` | 1254 × 1254 |
| `分辨率 1024 像素` | 1254 × 1254 |
| `宽 1024 高 1024 像素` | 1254 × 1254 |
| `2K 分辨率` | 1254 × 1254 |
| `4K 超高清分辨率` | 1254 × 1254 |
| `Render at 1024x1024 pixels` | 1254 × 1254 |
| `Render at 2048x2048 pixels` | 1254 × 1254 |

结论：**画幅（宽高比）能被提示词控制，像素尺寸不能**。既然如此，提供分辨率选项只会让用户
误以为能控制它 —— 所以界面只保留画幅，像素尺寸完全交给上游决定。

`codex/gpt-image-2` 也是 Magpie 中唯一能真正绘图的模型，其余模型在该端点只会返回文字。

## 账号与统计

### 首次部署

账号库为空时，登录页会显示引导界面。需要 `server/.env` 里配置管理密钥：

```ini
ADMIN_SETUP_KEY=换成你自己的长随机串
```

用它创建第一个管理员（会自动登录并进入后台）。**创建完成后这个接口就失效了**（账号库非空即拒绝），
所以管理密钥只在首次部署时有用。管理页建好管理员后，建议把 `ADMIN_SETUP_KEY` 清空。

### 登录与权限

| 角色 | 能做什么 |
| --- | --- |
| 管理员 | 生图 + 访问后台管理页（建账号、看统计、停用/删除账号） |
| 普通用户 | 只能生图 |

- 客户端**没有注册接口**，`POST /api/auth/register` 返回 404。账号一律由管理员在后台创建。
- 密码用 `scrypt` 加随机盐哈希存储，文件里没有明文。
- 会话用 HttpOnly Cookie，有效期 7 天；`SESSION_SECRET` 留空则每次启动重新生成（重启需重登）。
- 停用账号后该账号立即无法登录。

页面与接口双重把关：未登录访问工作台会跳转到登录页，未登录调用生图接口直接拒绝。

### 生图统计

每次生图都会记一条，落在 `usage.json`。统计记录的是**账号**，不是浏览器，
所以换设备登录同一账号，历史记录照样在。

后台能看到的：

- 累计生成张数、占用空间、参与账号数
- **按账号细分**：每个账号生成了多少张、占了多少空间、最近生成时间、占比条
- 最近 50 条生成明细：时间、账号、资产类型、名称、画幅、像素尺寸、文件大小

### 本地数据文件

全部落在项目根目录（路径可用环境变量改）：

```text
users.json    账号库（用户名、密码哈希、角色、启停状态）
usage.json    生图统计
styles.json   风格库
generated/    图片文件
```

`usage.json` 会随生图量增长，长期使用建议定期归档。

## 串行闸门

任何时刻只放行一个生图请求打向上游，避免多标签页或多个前端实例同时刷同一个账号触发风控。`/api/queue` 可查看当前是否忙碌与等待数。

## 资产批量工作台

位于 `http://127.0.0.1:5173/batch.html`。

- **导入一个 JSON = 新建一个项目**。每个项目是一份独立的资产数据，互不干扰，
  可随时切换、删除。项目存在后端 `projects.json`（可用 `PROJECT_DATABASE_PATH` 改路径），
  换浏览器、换机器打开同一地址都能读到同一批项目。
- 点右上角「项目」打开项目抽屉：查看全部项目、切换、删除，或新建空项目。
- 导入顶层为 `role`、`scene`、`prop` 的资产 JSON。
- 角色解析 `【字段】: 内容`，场景和道具解析分号分隔字段。
- 角色、场景、道具分别成页，自动统计数量，支持搜索与分页。
- 风格设定页提供三套互不干扰的风格库（角色/场景/道具），每套可新建、编辑、删除、设默认。
  风格属于**当前项目**，不同项目可以各用各的。
- 生成时以风格描述为最高优先级，拼接在资产内容之前。
- 每项资产独立保存提示词、比例、风格、状态与结果；导入数据存在浏览器 `localStorage`。
- 工具栏的**批量比例与批量风格**按资产类型分别记住，刷新页面后保持上次选择。
  标题下的说明会显示当前批量比例；点「应用到所选」会同时套用比例与风格。
- **风格库存放在后端** `styles.json`（可用 `STYLE_LIBRARY_PATH` 改路径），
  因此换浏览器、换机器打开同一地址都能读到同一份风格；`localStorage` 仅作为离线兜底。
- 批量生成在前端编排顺序执行，后端串行闸门保证不会并发。
- **每条资产有独立的进度条**。状态列显示该条资产自己的进度与阶段
  （正在理解画面 → 搭建构图 → 细化光影 → 完成渲染 → 接收图像 → 即将完成），
  排队中的资产显示队列位置，等待时进度条为空但可见。上游生图没有进度回调，
  这里的百分比是按阶段推进的模拟值，完成后会跳到 100%。

## 环境变量

见 `server/.env.example`。常用项：

```text
HOST / PORT                后端监听地址与端口
PUBLIC_BASE_URL            对外地址；留空按请求 Host 推断
MAGPIE_BASE_URL            上游 Magpie 网关，默认 http://127.0.0.1:3425
MAGPIE_IMAGE_MODEL         生图模型，默认 codex/gpt-image-2
IMAGE_TIMEOUT_MS           单次生成超时，默认 300000
MAX_PROMPT_LENGTH          提示词上限，默认 12000
STORAGE_DIR                图片存储目录，默认项目根 generated/
STYLE_LIBRARY_PATH        风格库文件，默认项目根 styles.json
USER_DATABASE_PATH        账号库文件，默认项目根 users.json
USAGE_DATABASE_PATH       生图统计文件，默认项目根 usage.json
PROJECT_DATABASE_PATH     项目库文件，默认项目根 projects.json
SESSION_SECRET            会话签名密钥，留空则每次启动随机生成
ADMIN_SETUP_KEY           引导创建首个管理员的管理密钥，留空则禁用引导
CORS_ORIGINS               允许的前端来源，逗号分隔
```

## 依赖

- 无需安装 `ffmpeg`：图片按上游原生尺寸直接交付，不做缩放或裁切。
- 端口默认：后端 8787，前端 5173。
