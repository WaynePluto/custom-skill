---
name: pixel2ase
description: 将 AI 生成的像素风图片转换为原生分辨率 PNG 和带索引调色板的 .aseprite 工程文件。管线包括：像素网格检测、相位对齐、降采样到真实分辨率、可选调色板量化、生成 indexed .aseprite。当用户要求把像素风图片转为 Aseprite 工程、还原像素画真实分辨率、清理 AI 生成图的像素格子，或为像素素材统一色板时使用。不适用于把普通照片/插画像素化（本技能不做风格转换）。
compatibility: Windows/macOS/Linux、Python 3.10+（numpy、Pillow）、本机已安装 Aseprite（支持 -b --script CLI）。
---

# pixel2ase：AI 像素风图片 → .aseprite 工程

把图像生成 AI 输出的"像素风"图片规范化为真正的像素画资产：

```
输入图片 ──► pipeline.py ──► 原生分辨率 PNG ──► png2ase.lua ──► indexed .aseprite
            (网格检测/降采样/量化)      │        (构建调色板/转索引模式)
                                        ▼
                                   verify.py（数值校验，无需图像识别）
```

## 前置条件

1. **Python 依赖**：`python -c "import numpy, PIL"` 验证；缺失时 `pip install numpy pillow`。
2. **Aseprite 路径**：定位 aseprite 可执行文件（常见位置：`D:\app\aseprite\aseprite.exe`、Steam 目录、或 `Get-Command aseprite`）。找不到时询问用户。下文以 `<ASEPRITE>` 指代。

## 第一步：原生分辨率还原（pipeline.py）

```shell
python <技能目录>/scripts/pipeline.py <input.png> <output.png> [--colors N] [--cell N]
```

参数：
- 无额外参数（默认）：自动检测格子尺寸并降采样；颜色原样保留。
- `--colors N`：量化到 N 色（感知加权 k-means）。仅在颜色数超过 256 或需要统一色板时使用。
- `--cell N`：强制指定格子尺寸，跳过自动检测。
- `--cell 1`：强制不降采样（图片已是原生分辨率）。

工作原理（阅读输出日志即可判断处理是否正确）：
1. **网格检测**：对灰度梯度做自相关，找到候选格子周期（2–24 px）。
2. **方差验证**：候选格子的格内方差 > 40 判定为伪周期（画面纹理造成），回退 cell=1 直通输出。真正的整数倍放大图格内方差接近 0。
3. **相位对齐**：搜索使格内方差最小的网格偏移。
4. **降采样**：取每格中心像素（不做平均，颜色零漂移）。

日志关键行示例：

```
grid detect: x-lag=4 (conf 0.91), y-lag=4 (conf 0.89)
verify cell=4: intra-cell variance = 3.2      ← 低方差，确认是 4x 放大图
native = 320x180, colors = 213
```

## 第二步：结果验证（必须执行）

先运行数值校验（无论是否具备图像识别能力都要跑）：

```shell
python <技能目录>/scripts/verify.py <input.png> <output.png>
```

输出三项客观指标与 PASS / WARN / FAIL 判定：

| 指标 | 含义 | 阈值 |
|------|------|------|
| grid fidelity | 输出图按检测倍数放大回去与原图的逐像素一致率 | < 85% 判 FAIL，格子尺寸判断错误 |
| residual grid | 输出图中仍存在的 NxN 均匀块占比 | > 60% 判 FAIL，降采样不足 |
| colors | 唯一颜色数 | > 256 判 WARN，需量化后才能转 indexed |

FAIL 时按提示重跑第一步（脚本会直接给出建议的 `--cell N` 参数），再次验证直到 PASS。

**重要**：数值指标只能判断网格与色板是否正确，**无法判断画质**（人脸是否糊、色调是否偏）。因此还需要下面二选一的画质确认。

### 方式 A：具备图像识别能力时（首选）

生成最近邻放大预览后用 read 工具查看：

```shell
& '<ASEPRITE>' -b <output.png> --scale 3 --save-as <preview.png>
```

对比原图与预览图，检查：
1. **精细区域清晰度**：人脸、文字、细线是否清晰。糊了 = 降采样过度，改用 `--cell 1` 重跑。
2. **格子完整性**：每个逻辑像素应是完整纯色方块，无边缘串色。
3. **色调一致性**：与原图相比是否发闷/偏色。偏色 = 量化过度，去掉 `--colors` 或增大 N。

### 方式 B：不具备图像识别能力时（人工验证降级）

**不要跳过验证，也不要假设结果正确**。生成预览图后交给用户确认：

```shell
& '<ASEPRITE>' -b <output.png> --scale 3 --save-as <preview.png>
```

然后向用户报告数值指标，给出预览图的**绝对路径**，并请其确认以下三点（等待回复后再继续）：

> 数值校验已 PASS（grid fidelity 100%，256 色）。我无法直接查看图片，请你打开以下文件确认画质：
>
> - 原图：`<input 绝对路径>`
> - 处理结果（3 倍放大预览）：`<preview 绝对路径>`
>
> 请确认三点：
> 1. 人脸/文字等精细部位是否清晰（不糊）？
> 2. 放大后每个像素是否是完整的纯色方块（格子横平竖直、无串色）？
> 3. 色调与原图相比是否一致（不发闷、不偏色）？
>
> 若有问题请告诉我是哪一项，我会调整参数重跑。

用户反馈对应的处理：
- 「糊」 → `--cell 1` 重跑
- 「格子发花/歪斜」 → 请用户目测格子边长，用 `--cell N` 重跑
- 「偏色/发闷」 → 去掉 `--colors` 或增大 N 重跑

用户确认通过后才进入第三步。

## 第三步：生成 .aseprite 工程（png2ase.lua）

```shell
& '<ASEPRITE>' -b --script-param in=<output.png> --script-param out=<name.aseprite> --script <技能目录>/scripts/png2ase.lua
```

- 调色板从图像实际颜色构建，转 indexed 模式，颜色无损。
- 颜色数 > 256 时脚本会报错——回到第一步加 `--colors 256`（或更少）重跑。
- 需要保持 RGB 模式（只挂调色板不转索引）时加 `--script-param mode=rgb`。
- 注意：`in`/`out` 路径建议用绝对路径或先 `cd` 到工作目录。

## 第四步：无损校验（推荐）

```shell
& '<ASEPRITE>' -b <name.aseprite> --save-as <verify.png>
python -c "import numpy as np; from PIL import Image; a=np.asarray(Image.open('<output.png>').convert('RGB')); b=np.asarray(Image.open('<verify.png>').convert('RGB')); print('identical:', np.array_equal(a,b))"
```

输出 `identical: True` 即为无损转换，删除 verify.png。

## 已知局限与对策

| 情形 | 表现 | 对策 |
|------|------|------|
| 格子不均匀的 AI 生成图 | 方差验证误判 cell=1，输出格子歪斜 | 手动 `--cell N`；仍不行则先让用户用图像 AI 重生成更规整的图 |
| 格子 > 24 px | 检测不到 | 手动 `--cell N` |
| 非整数倍缩放图 | 格子为小数，无法处理 | 先用最近邻缩放回整数倍尺寸再处理 |
| 普通照片/插画 | 直通输出，不会像素化 | 本技能不做风格转换，向用户说明 |
| 大图 + `--colors` | k-means 较慢 | 正常等待，或先降采样再量化 |

## 输出约定

- 产物命名：`<原名>_native.png` 与 `<原名>.aseprite`（用户有指定时以用户为准）。
- 中间预览文件（`*_x2.png`、`preview.png`、`verify.png` 等）在任务结束时清理。
- 完成后向用户报告：原始尺寸 → 原生尺寸、格子倍数、颜色数、verify.py 判定结果、是否无损。
