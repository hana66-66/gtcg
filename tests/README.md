# GTCG 自动化测试

用真实 Edge/Chrome（CDP 驱动）打开**真实的 index.html** 跑断言，不依赖任何 npm 包。

> 教训：早期版本用一个单独的 `harness.html` 复刻页面结构来测，
> 结果测试全绿但真人根本打不出牌 —— 因为 harness 和真实页面的 DOM/交互早已不一致。
> 现在所有测试都直接跑 `../index.html`，杜绝再次脱节。

| 文件 | 用途 | 命令 |
|---|---|---|
| `run.mjs` | 规则 + 界面 + 交互自检（71 条断言） | `node tests/run.mjs` |
| `measure.mjs` | 量各区域矩形，检测区块重叠 | `node tests/measure.mjs` |
| `mouse.mjs` | 真实鼠标事件验证点击出牌 | `node tests/mouse.mjs` |
| `shot.mjs` | 摆一个中局场面并截图 | `node tests/shot.mjs` |

约定：测试会注入 `window.GTCG_AUTO`（自动应答弹窗）与 `window.GTCG_FAST`（跳过动画延时），
这样无人值守也能跑完；真实页面本身不含这两个钩子。
