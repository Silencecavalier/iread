# tools/

两个本地小工具，只在开发调试时用，不进安装包。

## fixture-server.js —— 书源测试站

内置示例书源指向 `http://127.0.0.1:8123`，就是这个服务。

```bash
node tools/fixture-server.js          # 默认 8123
node tools/fixture-server.js 9000     # 换端口（记得同步改书源里的 bookSourceUrl）
```

| 路径 | 说明 |
| --- | --- |
| `GET /search?q=&page=` | HTML 列表（`.book-item` / `h3 a` / `.author` / `.intro` / `.latest`） |
| `GET /book/:id` | HTML 详情（`//h1[@class="book-title"]` 等，XPath 示例用） |
| `GET /toc/:id` | HTML 目录（`#chapter-list li a`） |
| `GET /chapter/:id-:n` | HTML 正文（`#content`） |
| `GET /api/search?q=` | JSON 列表，配 JSONPath 书源用 |
| `GET /api/book/:id` | JSON 详情 |
| `GET /api/chapter/:id-:n` | JSON 正文 |

数据是写死的几本假书（《长夜行》《灯下集》…），正文是占位文字，只为验证规则能不能跑通。**它不抓任何真实站点。**

用法：应用里「我的 → 书源 → 示例书源」把 `示例 · 本地演示站` 打开，或者直接拿它的规则当模板改自己的书源。

## cdp-eval.js —— 对运行中的应用求值

```bash
# 1) 带调试端口启动
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9336 ./dist/publish/iread-plugin.exe

# 2) 写一个表达式文件（必须是一个完整表达式，推荐 IIFE）
cat > /tmp/expr.js <<'EOF'
(() => ({ view: NR.state().view, books: NR.state().index.length, err: NR.plugins.errors() }))()
EOF

# 3) 求值
node tools/cdp-eval.js 9336 /tmp/expr.js
```

输出是 `JSON.stringify(result, null, 1)`，异常打印 `EXC ...`。

> `location.reload()` 会让 CDP 的 execution context 作废（`Execution context was destroyed`）。刷新页面后重新跑一次就行，别在表达式里刷新。
