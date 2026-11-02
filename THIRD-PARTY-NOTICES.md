# 第三方组件与来源声明

本项目包含或参考了以下第三方作品。各自的版权归原作者所有。

## 1. html2canvas 1.4.1（内置）

- 路径：`linuxdo-personal-feed-manager/vendor/html2canvas.min.js`
- 版权：Copyright (c) 2022 Niklas von Hertzen <https://hertzen.com>
- 主页：<https://html2canvas.hertzen.com>
- 许可：MIT License
- 用途：「保存为图片」功能把帖子渲染成 PNG。
- 改动：未修改，原样内置（压缩版），文件内保留了原始版权头。

## 2. LinuxDo 增强阅读 v1.8.7（内置引擎，已改造）

- 路径：`linuxdo-personal-feed-manager/vendor/linuxdo-enhanced-reading.js`
- 作者：Fashion
- 许可：MIT License
- 原始分发：Greasy Fork script 584412
  <https://update.greasyfork.org/scripts/584412/LinuxDo%20%E5%A2%9E%E5%BC%BA%E9%98%85%E8%AF%BB.user.js>
- 用途：列表页点标题弹窗预览整帖（LDFC 的预览窗口引擎）。
- 改动（已在文件头注明）：去掉它自带的点击拦截，改为对外暴露
  `LDFCEnhancedPreview`，由 LDFC 决定何时打开预览。

## 3. linux.do 小助手（功能参考，未内联代码）

- 作者：quantumcat & nulluser & enhanced & idear
- 许可：MIT License
- 参考的功能：只看楼主 / 展开楼中楼 / 随机跳楼 / 保存到本地（HTML）/ 保存为图片 /
  按楼层跳转。
- 说明：本项目**没有**把该脚本的代码整段复制进来（全量检索其
  `GM_*` / `unsafeWindow` / `GM_getValue` 等特征均为 0 命中），
  这些按钮是按相同功能重新实现的。

---

## MIT License（适用于上述第 1、2、3 项）

Copyright (c) 各自作者，见上。

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
