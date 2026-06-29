# 桌别零公网部署：Render

这个项目已经整理成 Render 可部署的单服务结构：前端静态文件和 Socket.IO 后端都由同一个 Node 服务提供。

## 1. 上传到 GitHub

Render 需要从 GitHub 或 GitLab 拉取代码。先把 `C:\Users\17323\Desktop\codex-1\zhuoyou` 上传到一个新的 GitHub 仓库。

如果你还没用过 GitHub，可以先在网页上创建仓库，然后在本机执行：

```powershell
cd C:\Users\17323\Desktop\codex-1\zhuoyou
git init
git add .
git commit -m "Initial zhuobieling website"
git branch -M main
git remote add origin 你的GitHub仓库地址
git push -u origin main
```

## 2. 在 Render 创建服务

推荐用 Blueprint：

1. 登录 Render。
2. 选择 New，找到 Blueprint。
3. 连接你的 GitHub 仓库。
4. Render 会读取项目根目录的 `render.yaml`。
5. 确认服务名称为 `zhuobieling`。
6. 创建服务，等待构建完成。

也可以手动创建 Web Service：

- Runtime：Node
- Build Command：`npm ci && npm run build`
- Start Command：`npm start`
- Health Check Path：`/api/health`

## 3. 部署成功后测试

Render 会给你一个公网地址，类似：

```text
https://zhuobieling.onrender.com
```

打开后测试：

- 首页能看到“桌别零”和 logo。
- 一个浏览器创建房间。
- 手机或另一个浏览器输入房间号加入。
- 测试谁是卧底、五子棋、飞行棋简版。

## 4. Supabase 后续再接

第一次公网测试可以先不配置 Supabase，游客模式能正常玩。

确认朋友能进房间后，再在 Render 环境变量里添加：

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

添加 `VITE_` 前端变量后，需要重新部署，因为它们会在构建时写进前端。

## 5. 注意

免费实例可能会休眠，第一次打开会慢一些。实时游戏正式给很多人使用时，建议升级到付费实例。
