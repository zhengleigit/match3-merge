# 主题（皮肤）制作指南

游戏的所有视觉与音效资源都是**可选**的：任何槽位缺失都会自动回退到程序化绘制/合成音，
所以**永远不会有白屏或缺图报错**。

- 内置 `default` 主题不含任何素材，全部由代码绘制。
- 内置 `example` 主题演示如何用图片与音频替换每一个元素。

## 目录结构

```
public/themes/
  <主题名>/
    theme.json         主题清单（必需）
    blocks/level1.svg  方块图（可选，命名随意，只要在 theme.json 里指对）
    audio/merge.wav    音效覆写（可选）

src/themes/packs/
  <任意名字>.zip         zip 主题包，丢进来即自动出现（无需登记）
```

### 方式一：文件夹主题（开发时用）

1. 新建目录 `public/themes/<主题名>/`，放入素材与 `theme.json`。
2. 在 `src/data/themes.json` 的 `themes` 数组里加一条：

```json
{ "id": "my-theme", "name": "我的主题", "dir": "themes/my-theme", "description": "" }
```

`dir` **必须是相对路径**（不能以 `/` 开头，也不能带 `file://` 这类协议），
否则打进 exe / apk 后会 404 —— 校验会直接拒绝这种写法并给出警告。

### 方式二：zip 主题包（分发时用）

把上一条里的主题目录（含 `theme.json`）压成一个 zip，放进 `src/themes/packs/` 即可。
**不需要改任何清单**：

```
src/themes/packs/neon.zip
  └─ theme.json
  └─ blocks/level1.svg … level10.svg
  └─ page-bg.svg  home-bg.svg  board-bg.svg  obstacle.svg
  └─ slot-*.svg
```

- `npm run dev` 下丢入 zip 会立即生效（热更新会重新求值包列表）。
- `npm run build` 后新的包才会进构建产物——包列表是构建时扫描出来的，不是运行时。
  之所以这么做：浏览器无法枚举本地目录，静态站点也没有目录索引。
- zip 里如果多包了一层同名目录（“压缩这个文件夹”的默认行为），加载时会自动剥掉，
  两种压缩方式都能用。
- 支持 store 与 deflate 两种压缩，以及常规 zip / 7-Zip / Windows 右键压缩。
  ZIP64、加密条目、不支持的压缩方式会被跳过并给出警告（其余条目照常生效）。
- 设置里显示的名字优先取 `theme.json` 的 `name`，取不到则用 zip 文件名。

仓库自带两个示例包（`neon.zip` / `paper.zip`），可用脚本重新生成：

```
node tools/build-theme-packs.mjs
```

## theme.json

```json
{
  "id": "example",
  "name": "示例素材（SVG）",
  "blockScale": 1,
  "padding": 0.06,
  "slots": {
    "block.level1": "blocks/level1.svg",
    "sfx.merge": "audio/merge.wav"
  }
}
```

| 字段 | 说明 |
|---|---|
| `id` / `name` | 缺省时分别回退到目录名与 id |
| `blockScale` | 方块整体缩放（1 = 填满格子），仅作用于方块 |
| `padding` | 格子四周留白占格子的比例（0.06 即两侧各留 3%） |
| `slots` | 槽位 → 相对本目录的路径；写 `null` 或不写 = 用程序化绘制 |

## 槽位清单

### 方块

`block.level1` … `block.level10`

- 基础 / 障碍模式只用到 1–5；无尽模式用到 1–10。
- 建议正方形 256×256，透明底 PNG 或 SVG。
- **重要**：素材自己就是等级的唯一表达，渲染器不会再按等级缩放它。
  所以请让低级方块在画布内**明显更小**（例如 1 级占 80%、10 级占 98%），
  这样"从小到大 5 种"的观感才成立。`example` 主题用的就是"颜色 + 内嵌多边形边数"双重编码。
- **如果素材上带数字，请写等级号（1、2、3…），不要写分值**。
  程序化绘制的方块显示的是等级，换成素材后两边观感要一致。

### 背景

| 槽位 | 说明 |
|---|---|
| `page.background` | 局内页面背景，按**覆盖**方式填满画布（会裁切，注意构图居中） |
| `home.background` | **主页**背景，同样按覆盖方式填满。主页文字与卡片上方会自动加一层遮罩，
所以背景尽量做得暗一些、低对比一些 |
| `board.background` | 棋盘底纹，会**拉伸**到 7×10 的矩形 |

> `board.background` 会被拉伸成非正方形（例如 532×760），
> 所以请使用渐变/噪点这类**可拉伸**的设计，避免硬边框和圆角（会被拉变形）。

### 其他

| 槽位 | 说明 |
|---|---|
| `obstacle` | 障碍物（障碍模式） |
| `slot.buffer` | 暂存区 3 个槽位 |
| `slot.next` | "下一个方块"槽位 |
| `slot.cellFrame` | 空格子边框 |
| `slot.highlight` | 选中/悬停高亮 |

### 音效

`sfx.<id>`，可用 id：

`pick`（取到暂存区）、`spawn`（生成新方块）、`place`（落子）、`merge`（合成）、
`maxClear`（最高级整团清场）、`obstacleSpawn`、`obstacleBreak`、`invalid`（非法操作）、
`undo`、`win`、`gameOver`

- 支持浏览器能解码的格式（`.wav` / `.mp3` / `.ogg`）。
- 未提供或解码失败 → 回退到内置 Web Audio 合成音。
- 合成的 `merge` 还会按连锁层数升调，换成固定音频后就没有升调效果了。

## 校验与回退规则

- `theme.json` 取不到 → 整个主题回退为程序化绘制，控制台一条警告。
- zip 包不是合法 zip / 取不到 / 没有 `theme.json` → 该包不出现在主题列表里，控制台一条警告。
- 槽位为 `null` → 该元素用程序化绘制。
- 文件 404 或解码失败 → 该元素用程序化绘制，控制台一条警告（同一问题只报一次）。
- 未知槽位名、绝对路径、非法值 → 忽略该槽位并警告，其余照常生效。
- 换主题时，上一个主题的音频覆写会被整体替换（不是合并），
  否则新主题缺少某个音效时会继续放旧主题的音频。
- 记着的主题如果被删除了（例如 zip 被拿走）→ 回退到列表里第一个主题，不会白屏。

## 重新生成示例素材

`example` 主题的占位素材与两个 zip 示例包都是脚本生成的，改配色/形状后可重新产出：

```
node tools/generate-placeholder-theme.mjs   # public/themes/example/**
node tools/build-theme-packs.mjs            # src/themes/packs/*.zip
```

这两个脚本会**整个重写**对应目录，所以不要手改生成出来的文件，要改就改脚本。
