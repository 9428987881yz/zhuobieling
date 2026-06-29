# 桌别零

桌别零是一个普通网页端的多人在线桌游房间：玩家输入昵称即可创建或加入房间，房主选择游戏并开始，房间内支持实时同步和文字聊天。首版包含谁是卧底、五子棋、飞行棋简版。

## 本地运行

```bash
npm install
npm run dev
```

开发模式会同时启动：

- 前端：`http://localhost:5173`
- 实时后端：`http://localhost:3001`

也可以先构建，再用单服务模式运行：

```bash
npm run build
npm start
```

单服务模式访问 `http://localhost:3001`，这也是之后部署时的结构。

## 品牌素材

网站 logo 已放在 `src/assets/zhuobieling-logo.jpg`。版权登记材料在 `copyright/`，商标材料草稿在 `trademark/`。

## Supabase 账号和战绩

不配置 Supabase 也能用游客模式联机玩。要启用邮箱注册、个人资料和战绩保存：

1. 创建 Supabase 项目。
2. 在 SQL Editor 执行 `supabase/schema.sql`。
3. 复制 `.env.example` 为 `.env`，填写：

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

`VITE_` 开头的变量给前端使用；`SUPABASE_SERVICE_ROLE_KEY` 只给后端写入战绩使用，不要公开到浏览器。

## 游戏规则

- 谁是卧底：3-8 人，系统发词，轮流发言后投票；投出卧底则平民胜，剩 2 人且卧底仍在场则卧底胜。
- 五子棋：2 人，15x15 棋盘，黑白轮流落子，先连成五子获胜。
- 飞行棋简版：2-4 人，轮流掷骰前进，率先到达第 30 格获胜。

## 部署提示

这个项目使用 Socket.IO，需要选择支持 WebSocket 的平台。部署命令通常是：

```bash
npm install
npm run build
npm start
```

服务端默认读取 `PORT` 环境变量。若前端和后端分开部署，需要设置 `CLIENT_ORIGIN` 和 `VITE_SOCKET_URL`。

更详细的 Render 公网部署步骤见 [DEPLOY_RENDER.md](DEPLOY_RENDER.md)。
