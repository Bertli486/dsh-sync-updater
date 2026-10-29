# dsh-sync-updater

> 在 DSH（DeepSeek Harness）里统一管理已安装技能与插件的同步更新器：侧栏面板 + 模型工具 + 定时检查。
> A sync-updater for DSH skills and plugins — sidebar panel, model-facing tools, scheduled checks.

在 DSH 里统一管理「已安装的技能」和「已安装的插件」的同步更新器。

DSH 本身没有后台更新器：插件管理器只响应显式操作，技能提供器只监听文件变化、从不拉上游。
这个插件把两边的清单收拢到一处，给你三样东西：

1. **侧栏「同步」面板** —— 「已安装」看清单/开关自动更新/点按钮更新，「发现」搜 skills.sh 并一键安装
2. **三个模型工具** —— `sync_status` / `sync_check` / `sync_apply`，用一句话让 agent 去查/去更新
3. **后台定时检查** —— 间隔和开关都能在面板里实时改，不用改配置、不用重启

## 安装

```sh
dsh plugin --profile web add github:Bertli486/dsh-sync-updater
```

`web` 换成宿主实际的 profile 名；DSH Desktop 也可以在「设置 → 插件」里装。重启后左侧栏出现「同步」入口，同时获得 `sync_status` / `sync_check` / `sync_apply` 三个工具。

手动挂进 profile 也可以（以 `link:` 方式，改代码即时生效，适合开发）：

```bash
git clone https://github.com/Bertli486/dsh-sync-updater.git ~/dsh-sync-updater
cd ~/.dsh/profiles/desktop && pnpm add link:$HOME/dsh-sync-updater
```

再把 `dsh-sync-updater` 加进 profile `package.json` 的 `dsh.profile.bundles`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-sync-updater"] } }
}
```

> 桌面版 PATH 里通常没有 pnpm，可以用 DSH 自带的那份：
> `~/.dsh/dsh-runtimes/*/dependencies/pnpm` + 同目录下的 `node`。

调试时可以直接对宿主路由发请求：

```bash
curl -s http://127.0.0.1:<port>/sync-updater/api/state | jq .
```

## 侧栏面板

重启 DSH 后，左侧栏会出现一个「同步」入口（图标在插件列表下方），点开是：

- **自动更新**：检查频率（关闭 / 30 分钟 / 1 小时 / 6 小时 / 24 小时）+「检查到技能更新时自动应用」开关
- **操作**：检查更新、更新技能（N）、更新插件（N），右侧显示上次检查时间和结果
- **技能列表**：名称、状态徽标、上游仓库、最近的检查结论，每行带更新按钮
- **插件列表**：安装版本 → 最新版本、来源（registry / 本地 link / 随 App 提供），每行带更新按钮
- **最近操作**：本次会话里做过什么、结果如何

### 发现页

- 搜索走 skills.sh 的公开接口，返回 `owner/repo` + `skillId` + 安装量
- 每行的「安装」会先查一次**安全审计**（Gen Agent Trust Hub / Socket / Snyk / Runlayer / ZeroLeaks）；结论是 `fail` 或 `HIGH/CRITICAL` 时按钮变成「仍要安装」，需要二次确认
- 安装用 **git blobless clone** 定位仓库里的技能目录（按 `SKILL.md` 的父目录名匹配），再稀疏检出、复制到 `~/.agents/skills/<skillId>`，全程非交互，不依赖 node/npm
  - 装完会在 `state.json` 的 `installed` 里记下 `source` / `repoDir`，之后 `sync_check` 能认出它的上游，更新走和 `.skill-lock.json` 一样的下载逻辑
- 仓库里找不到同名目录时才回退到 `skillshare install`（它是 TUI 交互式，非交互场景容易挂起，所以只作兜底）

面板写下的开关存在 `~/.dsh/sync-updater/settings.json`，**优先于** `cordis.patch.yml` 里的配置，保存后立刻重排定时器。

## 模型工具

| 工具 | 作用 | 联网 |
|---|---|---|
| `sync_status` | 技能 + 插件清单（版本、来源、路径、自动检查配置、上次结果） | 否 |
| `sync_check` | 检查更新：插件对比 npm registry；技能对比上游 `SKILL.md` 哈希或本地 git 分支 | 是 |
| `sync_apply` | 应用更新：技能下载/`git pull`/skillshare；插件 `pnpm add` | 是 |

`sync_apply` 参数：`targets`（`['skills']`/`['plugins']`）、`names`（只处理指定项）、`dryRun`、`toLatest`（插件跨出声明范围升到 latest，默认关闭）。

## 它覆盖哪些东西

**技能**（按 DSH 的扫描顺序，先到先得）

- `<cwd>/.dsh/skills`、`<cwd>/.agents/skills`
- `~/.dsh/skills`、`~/.agents/skills`
- `~/.config/skillshare/skills`（skillshare 源）
- 软链接会被跟随（skillshare `sync` 之后技能就是软链），更新时改的是真实目录

**插件**

- profile `package.json` 里的全部依赖
- `@deepseek-ai/*` 与 `dsh` 标记为「随 App 提供」，不会尝试升级
- `link:` / `file:` / git / tarball 标记为本地或非 registry 来源

## 更新是怎么做的

技能三种来源：

1. **有 `~/.agents/.skill-lock.json` 记录**（`skills` CLI 装的）
   - 检测：拉 `raw.githubusercontent.com` 上同路径 `SKILL.md` 算 sha256（不吃 GitHub API 的 60 次/时限额）
   - 更新：`git clone --depth 1 --filter=blob:none --sparse` 只取该技能目录，整体替换
   - 不改 `.skill-lock.json`：哈希归 `skills` CLI 维护，擅自改会让它把技能判成 modified
2. **git 工作树内**（tracked repo）：`git fetch` + `rev-list` 判断落后提交数，更新用 `git pull --ff-only`
3. **skillshare 源**：交给 `skillshare update <name> -g` + `skillshare sync -g`

插件：读 registry 的 `dist-tags.latest`，默认只在原声明范围内升级，安装时**锁定到具体版本**（只写 range 时 pnpm 会保留旧版本，等于没升）。失败会还原 `package.json` 和 `pnpm-lock.yaml`。

## 配置（可选）

`cordis.patch.yml` 里的 config 是默认值，面板可以覆盖：

```yaml
- id: sync-updater
  name: 'dsh-sync-updater'
  config:
    autoCheckIntervalMinutes: 360   # 0 = 关闭；面板可改
    autoApplySkills: false          # 面板可改
    includeProjectSkills: true
    includeUserSkills: true
    registry: ''
    pnpmCommand: ''
    gitCommand: ''
    skillshareCommand: ''
```

## 状态、日志与备份

- `~/.dsh/sync-updater/settings.json` — 面板写入的开关
- `~/.dsh/sync-updater/state.json` — 上次检查/执行结果、上游基线、历史（50 条）
- `~/.dsh/sync-updater/plugin.log` — 加载与执行日志
- `~/.dsh/sync-updater/backups/<时间戳>/<技能名>/` — 每次替换前的整目录备份（不自动清理）

## HTTP API（面板用的就是这几个）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sync-updater/api/state` | 清单 + 设置 + 上次结果 |
| POST | `/sync-updater/api/check` | 检查更新 |
| POST | `/sync-updater/api/apply` | `{targets?, names?, toLatest?}` 应用更新 |
| POST | `/sync-updater/api/settings` | `{autoCheckIntervalMinutes?, autoApplySkills?}` 保存开关并重排定时器 |
| GET | `/sync-updater/api/discover?q=&owner=` | 搜 skills.sh（公开搜索接口），返回已安装列表用于打标 |
| GET | `/sync-updater/api/audit?source=&slug=` | 拉某技能的多厂商审计结论 |
| POST | `/sync-updater/api/install` | `{source, skillId, dryRun?}` 安装：git 定位+稀疏检出，兜底 skillshare |

## 安全边界

- 不升级随 DSH 安装提供的包
- 不删除技能，只替换内容；替换前整目录备份
- 下载内容缺少 `SKILL.md` 就放弃替换，保留原样
- 插件安装失败回滚 manifest 与 lockfile
- 外部命令一律数组传参，不经过 shell

## 开发

```bash
node --test        # 10 个用例：semver、扫描、来源判定、git pull、HTTP 路由、工具注册
```

改了 `lib/index.js` 或 `lib/client.js` 需要重启 DSH 才生效——HMR 只热重载配置，不重载模块根。

## 已知限制

- 只跟踪 `SKILL.md` 的内容变化；技能里附带的其他文件（如 `agents/*.yaml`）变了不会单独提示，但更新时会整体替换
- 上游仓库改名/移动后需要手动修正 `.skill-lock.json` 或重装技能
- 发现页依赖 skills.sh 的**未文档化**搜索接口（网页内部用）；它一变就只剩报错，不影响更新功能
- 通过发现页装的技能直接落在 `~/.agents/skills`，没有进 skillshare 的源目录；skillshare `sync` 不会删除它，但也不会同步到 codex 等 target
- 桌面版 PATH 里通常没有 pnpm，插件会自动找 `~/.dsh/dsh-runtimes/*/dependencies/pnpm`

## 许可

MIT，见 [LICENSE](LICENSE)。
