# 知乎「我的回答」批量下载（油猴脚本）

一个 Tampermonkey 油猴脚本：打开知乎后，一键（或自动）获取**当前登录账号**的全部回答，
逐条转成 Markdown，打包成单个 zip 下载到指定子目录。

## 功能

- 自动识别当前登录账号（无需手填 url_token）
- 分页拉取全部回答（含正文）
- 每条回答转 Markdown（Turndown），文件名为 `日期_问题标题.md`
- 全部回答 + `_index.md` 目录索引打包成 **一个 zip**，一次性下载（无大量弹窗）
- 落到 `下载目录/zhihu-answers/` 子目录
- 可选「打开知乎自动运行」，带节流避免重复下载

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 新建脚本，粘贴 `zhihu-my-answers-download.user.js` 内容并保存
3. 打开知乎任意页面，点击右下角「⬇ 下载我的全部回答」按钮

## 配置（脚本顶部 CONFIG）

| 项 | 说明 | 默认 |
| --- | --- | --- |
| `subDir` | 下载子目录（相对浏览器默认下载目录） | `zhihu-answers` |
| `autoRun` | 打开知乎是否自动运行 | `false` |
| `autoRunIntervalHours` | 自动运行最小间隔（小时） | `12` |
| `pageLimit` | 每页拉取数量（知乎上限 20） | `20` |
| `pageDelayMs` | 翻页延迟（毫秒） | `800` |

## 下载到特定目录 / 坚果云

浏览器下载只能落到「默认下载目录」或其子目录，无法指定任意绝对路径。
若要同步到坚果云：

1. Chrome 设置 → 下载内容 → 将「下载位置」设为坚果云同步盘下的某文件夹，并关闭「下载前询问位置」
2. Tampermonkey 设置 → 下载模式选「浏览器 API」，允许 `GM_download` 使用子目录
3. zip 会进入 `坚果云同步盘/zhihu-answers/` 并自动同步上云

## 说明

- 脚本通过 `@require` 引入 JSZip 与 Turndown（CDN），首次需联网
- 仅访问知乎自身接口，运行在真实登录上下文中

## License

MIT
