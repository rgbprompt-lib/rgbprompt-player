# RGBPrompt Player — Privacy

RGBPrompt Player runs lighting effects on your keyboard. It is designed so sensitive data
stays on your computer. The source code in this repository is what the Player does.

- **Keyboard input** (Input Monitoring on macOS, a low-level keyboard hook on Windows): used
  only to know which key position was pressed or released, so key-reactive effects can light
  the right key. Hardware key codes are mapped to generic key names. Key names are **not**
  logged, no keystroke history is kept, and keystrokes are **not** uploaded.
- **System audio** (Screen & System Audio Recording on macOS, WASAPI loopback on Windows):
  used only while a sound-reactive effect is playing. Audio is analysed locally into levels /
  frequency bands and discarded. Audio is **not** recorded to disk and **not** uploaded.
- **Screen content:** the Player does **not** capture screenshots or screen video.
- **Network:** the Player contacts RGBPrompt servers only to redeem a play token when you
  start an effect from the website, or to open the website when you ask it to. When you ask it
  to install OpenRGB, it downloads the pinned OpenRGB package (from openrgb.org or GitHub) and
  verifies its checksum. Lighting frames are not uploaded. Diagnostics you copy stay in your
  clipboard until you paste them somewhere yourself.
- **OpenRGB:** lighting is sent to a local OpenRGB process on your machine
  (`127.0.0.1:6742`). OpenRGB is a separate program with its own license and permissions.
- **Controls:** capture runs only while an effect that needs that input is playing. You can
  deny a system permission; the effect still plays, and only that input layer stays static.

Questions: open an issue on this repository. Security problems: see [SECURITY.md](SECURITY.md).

---

# RGBPrompt Player — 隐私说明

RGBPrompt Player 在你的键盘上播放灯效。敏感数据默认只留在本机；本仓库的源码就是 Player 实际做的事。

- **键盘输入**（macOS「输入监控」、Windows 低级键盘钩子）：只用来判断按下/松开的是哪个键位，好让按键灯效亮在正确的位置。键码只映射成通用键名；**不会**记录键名、**不会**保存按键历史、**不会**上传按键内容。
- **系统声音**（macOS「屏幕与系统音频录制」、Windows WASAPI 回环）：仅在播放「声音驱动」灯效时使用。音频只在本机分析成音量/频段后丢弃；**不会**录音到磁盘，**不会**上传音频。
- **屏幕画面**：Player **不会**截屏或录屏。
- **网络**：只有在你从网站播放灯效时兑换播放令牌、或你主动打开网站时，才会联系 RGBPrompt 服务器。你让它安装 OpenRGB 时，会从 openrgb.org 或 GitHub 下载固定版本的安装包并校验哈希。灯效帧不会上传。你复制的诊断信息只在剪贴板里，除非你自己粘贴出去。
- **OpenRGB**：灯效发给本机的 OpenRGB 进程（`127.0.0.1:6742`）。OpenRGB 是独立软件，有自己的许可与权限。
- **可控**：只有正在播放、且确实需要某种输入的灯效才会打开对应采集；你可以拒绝系统权限，灯效仍可播放，只是该层输入保持静止。

有问题请在本仓库提 issue；安全问题见 [SECURITY.md](SECURITY.md)。
