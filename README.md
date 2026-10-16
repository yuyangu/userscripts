# userscripts

自用油猴脚本合集（浏览器学习工具）+ 配套 Python 工具。

## 油猴脚本

| 脚本 | 用途 |
| --- | --- |
| [GXNU 课表采集器](https://raw.githubusercontent.com/yuyangu/userscripts/main/gxnu-course-collector.user.js) | 广西师大教务系统 / 易班课表页一键采集，导出 JSON 供 Obsidian 同步 |
| [GXNUFL 刷课助手](https://raw.githubusercontent.com/yuyangu/userscripts/main/gxnufl-auto-next.user.js) | 漓江学院在线课程：视频自动下一节 + 弹题自动处理 + 倍速/延迟面板 |
| [U校园 答题助手](https://raw.githubusercontent.com/yuyangu/userscripts/main/unipus-answer-helper.user.js) | U校园测试/作业：提取题目、答案回填、随机节奏填写 |

### 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 点击上表中脚本名称的链接，Tampermonkey 会自动弹出安装页
3. 点击「安装」即可

### 更新

脚本头部已配置 `@updateURL`，在 Tampermonkey 管理面板点击「**检查用户脚本更新**」即可一键更新。

## 配套工具

| 目录 | 用途 |
| --- | --- |
| [`sync/`](https://github.com/yuyangu/userscripts/tree/main/sync) | 课表同步脚本（Python）：读取「GXNU 课表采集器」导出的 JSON → 解析 → 变更比对 → 写入 Obsidian 课表笔记。详见 [sync/README.md](https://github.com/yuyangu/userscripts/blob/main/sync/README.md) |
