# 知乎「我的回答」增量下载（油猴脚本）

一个 Tampermonkey 油猴脚本：**打开知乎时自动增量同步**当前登录账号的回答，
每条回答单独存为 Markdown 文件，落到指定子目录。**只下载新增/有改动的**，
已下过且未改的自动跳过。**无任何外部依赖库**（HTML→Markdown 内置实现）。

## 功能

- 打开知乎自动增量同步，也可点右下角按钮手动触发
- 自动识别当前登录账号（无需手填 url_token）
- 增量：用油猴存储记录「已下载回答 + 更新时间」，仅下载新增或被编辑过的回答
- 每条回答单独存为 `问题标题_回答ID.md`，落到 `下载目录/zhihu-answers/`
- 内置轻量 HTML→Markdown（标题/加粗/链接/图片/列表/引用/代码），无需联网
- 油猴菜单提供「清空增量记录（下次重新下载全部）」

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 新版 Chrome 需在 `chrome://extensions` → Tampermonkey 详情中打开 **「允许用户脚本 / Allow user scripts」**
3. 打开 [脚本 raw 链接](https://github.com/zxysdtc/zhihu-my-answers-download/raw/main/zhihu-my-answers-download.user.js) 安装；或新建脚本粘贴内容保存
4. 打开知乎任意页面即自动同步；右下角按钮可手动触发

## 配置（脚本顶部 CONFIG）

| 项 | 说明 | 默认 |
| --- | --- | --- |
| `subDir` | 下载子目录（相对浏览器默认下载目录） | `zhihu-answers` |
| `autoRunOnOpen` | 打开知乎是否自动增量同步 | `true` |
| `minAutoRunGapMinutes` | 自动同步最小间隔（分钟），避免频繁刷新重复打 API | `10` |
| `pageLimit` | 每页拉取数量（知乎上限 20） | `20` |
| `pageDelayMs` | 翻页延迟（毫秒） | `700` |
| `downloadDelayMs` | 文件之间的下载间隔（毫秒） | `400` |

## 下载到特定目录 / 坚果云

浏览器下载只能落到「默认下载目录」或其子目录，无法指定任意绝对路径。
若要同步到坚果云：

1. Chrome 设置 → 下载内容 → 将「下载位置」设为坚果云同步盘下的某文件夹，并关闭「下载前询问位置」
2. Tampermonkey 设置 → 下载模式选「浏览器 API」，允许 `GM_download` 使用子目录
3. 文件会进入 `坚果云同步盘/zhihu-answers/` 并自动同步上云

## 限制说明

- 油猴脚本只能在「浏览器开着且有知乎标签页」时运行，**无法在浏览器关闭时后台定时**；
  本脚本的「定时」即为每次打开知乎时自动增量同步一次
- 被编辑过的回答会按更新时间重新下载，可能与旧文件并存（文件名带回答 ID，新文件可能被浏览器加 `(1)` 后缀）
- 仅访问知乎自身接口，运行在真实登录上下文中

## License

MIT
