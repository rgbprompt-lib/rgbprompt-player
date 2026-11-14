using Windows.ApplicationModel.Resources.Core;

namespace RGBPrompt.Player;

/// <summary>
/// Resolves a dotted i18n key such as <c>panel.status.driverNeeded</c> against
/// <c>Strings\{lang}\Resources.resw</c>. The PRI compiler stores dotted names
/// as a path, so the lookup uses slashes. A compiled fallback matches the
/// same .resw table so unpackaged debug builds still show text if the PRI
/// map is not loaded.
/// </summary>
public static class L10n
{
    public static string Tr(string key, string language, params object[] args)
    {
        var value = Resolve(key, language);
        if (args is { Length: > 0 })
        {
            try { return string.Format(value, args); }
            catch (FormatException) { return value; }
        }
        return value;
    }

    static string Resolve(string key, string language)
    {
        if (string.IsNullOrEmpty(key)) return key;
        try
        {
            var value = LookupPri(key.Replace('.', '/'), language);
            if (!string.IsNullOrEmpty(value)) return value;
        }
        catch (Exception)
        {
            // Missing PRI, unknown key, or ResourceManager not ready yet.
        }
        if (Fallback.TryGetValue(key, out var pair))
            return IsZh(language) ? pair.Zh : pair.En;
        return key;
    }

    static string? LookupPri(string resourceKey, string language)
    {
        var subtree = ResourceManager.Current.MainResourceMap.GetSubtree("Resources");
        var context = ResourceContext.GetForViewIndependentUse().Clone();
        context.QualifierValues["Language"] = IsZh(language) ? "zh-CN" : "en-US";
        return subtree.GetValue(resourceKey, context)?.ValueAsString;
    }

    static bool IsZh(string language) =>
        language.StartsWith("zh", StringComparison.OrdinalIgnoreCase);

    // Mirrors Strings\en-US\Resources.resw and Strings\zh-CN\Resources.resw.
    static readonly Dictionary<string, (string En, string Zh)> Fallback = new()
    {
        ["failure.internal"] = ("Something went wrong. Play it again.", "出了点问题，请再播一次。"),
        ["failure.updateRequired"] = ("Update RGBPrompt Player to play this light", "请更新 RGBPrompt Player 后再播放"),
        ["failure.decodeFailed"] = ("This effect can't play right now. The problem was logged.", "这个灯效暂时播不了，问题已记录"),
        ["failure.unsupportedPackage"] = ("This effect needs a newer Player. Please update and try again.", "这个灯效需要新版 Player，请更新后再播放"),
        ["failure.linkUnavailable"] = ("This link has expired. Play it again from the website.", "链接已失效，请从网站再播一次。"),
        ["failure.driverDeclined"] = ("Driver installation was cancelled", "已取消驱动安装"),
        ["failure.openrgbUnreachable"] = ("Couldn't reach the lighting backend", "连不上灯光后台"),
        ["failure.deviceLost"] = ("The keyboard was disconnected", "键盘已断开"),
        ["panel.status.connected"] = ("Connected · driver ready", "已连接 · 驱动就绪"),
        ["panel.status.preparing"] = ("Preparing…", "准备中…"),
        ["panel.status.driverNeeded"] = ("Driver needed", "需要安装驱动"),
        ["panel.status.noKeyboard"] = ("Driver ready · no keyboard found", "驱动就绪 · 未找到键盘"),
        ["panel.status.backendUnresponsive"] = ("Backend not responding", "后台无响应"),
        ["panel.status.vendorConflict"] = ("Vendor software is running", "厂商软件正在运行"),
        ["panel.status.blocked"] = ("Windows blocked the driver", "Windows 拦截了驱动"),
        ["panel.status.internalError"] = ("Player needs to be reinstalled", "Player 需要重新安装"),
        ["panel.nowPlaying"] = ("Now playing", "正在播放"),
        ["panel.stop"] = ("Stop", "停止"),
        ["support.perKey"] = ("per-key", "逐键"),
        ["support.zones"] = ("zones", "分区"),
        ["support.single"] = ("single color", "单色"),
        ["support.unknown"] = ("unknown layout", "未知布局"),
        ["app.name"] = ("RGBPrompt Player", "RGBPrompt Player"),
        ["panel.idle.drop"] = ("Nothing playing. Click 'Play on my keyboard' on the website, or open a .lep file.", "没有正在播放的灯效。在网站点击「在我的键盘上播放」，或打开一个 .lep 文件。"),
        ["panel.needsDriver.body"] = ("Player controls your keyboard lighting through the official OpenRGB. It installs into your user folder and won't replace an OpenRGB you already have.", "Player 通过官方 OpenRGB 控制键盘灯。它会装到你的用户目录，不会替换你已有的 OpenRGB。"),
        ["panel.needsDriver.install"] = ("Install and play", "安装并播放"),
        ["panel.noKeyboard.body"] = ("No RGB keyboard found. Plug it in with a cable, then retry.", "没找到 RGB 键盘。请用数据线直连后再试。"),
        ["panel.noKeyboard.findAgain"] = ("Find again", "重新查找"),
        ["panel.backend.unresponsive.body"] = ("Your keyboard keeps its current lighting. Restarting usually takes a few seconds and keeps your driver and effects.", "键盘会保持当前灯光。重启后台通常几秒就好，不影响已下载的驱动和灯效。"),
        ["panel.backend.restart"] = ("Restart backend", "重启后台"),
        ["panel.vendor.fallbackName"] = ("Vendor lighting software", "厂商灯光软件"),
        ["panel.vendor.running"] = ("{0} is running and holds the keyboard.", "{0} 正在运行，占用了键盘。"),
        ["panel.vendor.retry"] = ("I closed it, retry", "我已关闭，重试"),
        ["panel.blocked.body"] = ("Windows blocked the driver. Allow it once, then retry.", "Windows 拦截了驱动。请放行一次后再试。"),
        ["setup.button.retry"] = ("Retry", "重试"),
        ["panel.preparing"] = ("Preparing…", "正在准备…"),
        ["panel.coreUnavailable.body"] = ("The Player core does not match this app. Reinstall RGBPrompt Player.", "Player 内核与这个应用不匹配。请重新安装 RGBPrompt Player。"),
        ["panel.footer.settings"] = ("Settings…", "设置…"),
        ["panel.hide"] = ("Hide", "隐藏"),
        ["panel.footer.quit"] = ("Quit Player", "退出 Player"),
        ["panel.keyboard.fallback"] = ("Keyboard", "键盘"),
        ["panel.meta.fpsSupport"] = ("{0} · {1} fps · {2}", "{0} · {1} fps · {2}"),
        ["settings.title"] = ("RGBPrompt Player · Settings", "RGBPrompt Player · 设置"),
        ["settings.section.status"] = ("Status", "状态"),
        ["settings.section.preferences"] = ("Preferences", "偏好"),
        ["settings.preference.launchAtLogin"] = ("Launch at login", "开机时启动"),
        ["settings.sound.system"] = ("System sound", "系统声音"),
        ["settings.preference.keyReactive"] = ("Key-reactive lighting", "按键反应"),
        ["settings.preference.brightness"] = ("Brightness", "亮度"),
        ["settings.stop.title"] = ("When you stop or quit", "停止或退出时"),
        ["settings.stop.body"] = ("Keys go dark. Replug the keyboard to bring back its built-in lighting.", "键盘灯熄灭。重新插拔键盘即可恢复它自带的灯效。"),
        ["settings.footer.copyDiagnostics"] = ("Copy diagnostics", "复制诊断信息"),
        ["settings.footer.copied"] = ("Copied", "已复制"),
        ["settings.footer.unavailable"] = ("Unavailable", "暂不可用"),
        ["settings.footer.version"] = ("Player v{0}", "Player v{0}"),
        ["settings.status.driver"] = ("Light driver", "灯光驱动"),
        ["settings.status.keyboard"] = ("Keyboard", "键盘"),
        ["settings.status.keyboardMissing"] = ("Not found", "未找到"),
        ["tray.openPanel"] = ("Open panel", "打开面板"),
        ["tray.tooltip.playing"] = ("RGBPrompt Player · Playing", "RGBPrompt Player · 播放中"),
        ["tray.tooltip.attention"] = ("RGBPrompt Player · Needs attention", "RGBPrompt Player · 需要处理"),
        ["panel.needsDriver.title"] = ("Install the lighting driver (OpenRGB)", "安装灯光驱动（OpenRGB）"),
        ["panel.needsDriver.bullet.summary"] = ("Official OpenRGB {0} · about {1} MB", "官方 OpenRGB {0} · 约 {1} MB"),
        ["panel.needsDriver.bullet.versionOnly"] = ("Official OpenRGB {0}", "官方 OpenRGB {0}"),
        ["panel.needsDriver.bullet.verified"] = ("Verified after download (SHA-256)", "下载后校验完整性（SHA-256）"),
        ["panel.needsDriver.bullet.safe"] = ("Never flashes firmware; remove it any time", "不刷固件，随时可删除"),
        ["panel.needsDriver.later"] = ("Later", "稍后"),
        ["panel.needsDriver.percent"] = ("{0}%", "{0}%"),
        ["panel.noKeyboard.title"] = ("Keyboard not found", "没找到键盘"),
        ["panel.noKeyboard.subtitle"] = ("Your effect is ready, but no RGB keyboard was found", "灯效准备好了，但还没找到 RGB 键盘"),
        ["panel.noKeyboard.check1"] = ("Connect the keyboard with a cable (wireless and Bluetooth modes usually can't control lighting)", "用数据线直连键盘（无线 / 蓝牙模式通常不支持控灯）"),
        ["panel.noKeyboard.check2"] = ("Quit the keyboard maker's lighting app; it holds on to the device", "关掉键盘厂商的灯光软件，它会占用设备"),
        ["panel.noKeyboard.check3"] = ("Unplug it, plug it back in, then click Find again", "重新插拔后点「重新查找」"),
        ["panel.noKeyboard.supported"] = ("Supported keyboards", "支持的键盘"),
        ["panel.noKeyboard.footer"] = ("Playback resumes automatically when the keyboard is plugged in", "插上键盘后会自动继续"),
        ["panel.noKeyboard.deviceLost"] = ("Keyboard disconnected", "键盘已断开"),
        ["panel.idle.dropHere"] = ("Drop a .lep file here", "把 .lep 文件拖到这里"),
        ["panel.drop.release"] = ("Release to play", "松开即可播放"),
        ["panel.chip.audio"] = ("Following sound", "跟随声音"),
        ["panel.chip.keyOff"] = ("Key reaction is off", "按键反应未开启"),
        ["panel.chip.audioOff"] = ("Sound is off", "声音未开启"),
        ["panel.chip.enable"] = ("Turn on", "开启"),
        ["panel.more"] = ("More", "更多"),
        ["panel.footer.playLep"] = ("Open .lep file…", "打开 .lep 文件…"),
        ["panel.footer.defaultHandler"] = ("Make this the app for rgbprompt:// links", "把本应用设为 rgbprompt:// 链接的默认应用"),
        ["settings.preference.language"] = ("Language", "语言"),
        ["settings.language.chinese"] = ("中文", "中文"),
        ["settings.language.english"] = ("EN", "EN"),
        ["settings.status.webLink"] = ("Web link", "网页连接"),
        ["settings.status.webRegistered"] = ("rgbprompt:// registered", "rgbprompt:// 已注册"),
        ["settings.status.webMissing"] = ("Not registered", "未注册"),
        ["settings.webLink.makeDefault"] = ("Make default", "设为默认"),
        ["settings.footer.checkUpdates"] = ("Check for updates", "检查更新"),
        ["settings.status.driverReady"] = ("OpenRGB {0} · Ready", "OpenRGB {0} · 已就绪"),
        ["settings.status.driverExternal"] = ("OpenRGB · running on port {0}", "OpenRGB · 端口 {0} 运行中"),
        ["settings.status.driverMissing"] = ("Not installed", "未安装"),
        ["panel.failure.title"] = ("This effect can't play right now", "这个灯效暂时播不了"),
        ["panel.failure.line"] = ("Your keyboard keeps its current lighting. The problem was logged.", "键盘保持当前灯光，问题已记录。"),
        ["panel.createEffect"] = ("Create your own effect →", "创作你自己的灯效 →"),
        ["panel.backend.copyDiagnostics"] = ("Copy diagnostics", "复制诊断信息"),
        ["panel.backend.copied"] = ("Diagnostics copied", "诊断信息已复制"),
        ["panel.stoppedHint"] = ("Keyboard lights are off. Replug the keyboard to bring back its own lighting.", "键盘灯已关闭。重新插拔键盘可恢复它自带的灯效。"),
        ["setup.unverified.warning"] = ("This driver version hasn't been verified yet, so Player won't download it.", "这个驱动版本还没有通过校验，Player 不会下载它。"),
        ["setup.unverified.external"] = ("Already using OpenRGB? Turn on its SDK server (port 6742), then click Retry.", "如果你已经在用 OpenRGB：打开它的 SDK 服务器（端口 6742），然后点「重试」。"),
        ["setup.button.tryAgain"] = ("Try again", "再试一次"),
        ["setup.button.installing"] = ("Installing…", "安装中…"),
        ["setup.button.cancel"] = ("Cancel", "取消"),
        ["panel.backend.external.title"] = ("OpenRGB isn't running", "OpenRGB 未运行"),
        ["panel.backend.external.body"] = ("Player was using the OpenRGB you opened yourself (port {0}), and it has quit. Open OpenRGB again with its SDK server on, and Player reconnects automatically.", "Player 在用你自己打开的 OpenRGB（端口 {0}），它已经退出。重新打开 OpenRGB 并开启 SDK 服务器，Player 会自动重新连接。"),
        ["panel.backend.gaveUp.title"] = ("The lighting driver keeps quitting", "灯光驱动反复退出"),
        ["panel.backend.gaveUp.body"] = ("It quit {0} times in a minute, so Player stopped restarting it. Your keyboard keeps its current lighting.", "1 分钟内退出了 {0} 次，已停止自动重启。键盘会保持当前灯光。"),
        ["panel.backend.restarting.title"] = ("Restarting the lighting driver…", "正在重启灯光驱动…"),
        ["panel.backend.restarting.body"] = ("The driver quit unexpectedly. Player is restarting it (attempt {0} of {1}). Your keyboard keeps its current lighting.", "驱动意外退出了，Player 正在自动重启（第 {0}/{1} 次）。键盘会保持当前灯光。"),
        ["panel.backend.retryNow"] = ("Retry now", "立即重试"),
        ["panel.backend.unresponsive.title"] = ("Player's background service is stuck", "Player 的后台卡住了"),
        ["panel.backend.waiting"] = ("Waiting for OpenRGB…", "正在等待 OpenRGB…"),
        ["panel.blocked.title"] = ("Windows blocked the driver. Confirm once.", "Windows 拦下了驱动，确认一次就好"),
        ["panel.blocked.line"] = ("Allow it once, then try again", "放行一次就好"),
        ["panel.blocked.retry"] = ("I've allowed it, try again", "我已放行，再试一次"),
        ["panel.coreUnavailable.title"] = ("Player needs to be reinstalled", "Player 需要重新安装"),
        ["panel.footer.reopenVendors"] = ("You can reopen {0} after quitting", "退出后可以重新打开 {0}"),
        // Mac key is panel.more.keyboards; PRI forbids a key under another key (panel.more).
        ["panel.keyboards.header"] = ("Keyboard", "键盘"),
        ["panel.picker.choose"] = ("Choose effect", "选择灯效"),
        ["panel.picker.create"] = ("Create your own effect", "创作你自己的灯效"),
        ["panel.source.file"] = ("Local file", "本地文件"),
        ["panel.source.preset"] = ("Built-in effect", "内置灯效"),
        ["panel.source.web"] = ("From the RGBPrompt website", "来自 RGBPrompt 网页"),
        ["panel.status.ready"] = ("Ready", "就绪"),
        ["panel.status.restartingDriver"] = ("Restarting driver", "正在重启驱动"),
        ["panel.status.openrgbNotRunning"] = ("OpenRGB not running", "OpenRGB 未运行"),
        ["panel.untitled"] = ("Untitled effect", "未命名灯效"),
        ["panel.vendor.title"] = ("{0} is running", "{0} 正在运行"),
        ["panel.vendor.body"] = ("It controls the keyboard lights too, so RGBPrompt can't reach the keyboard.", "它也在控制键盘灯，所以 RGBPrompt 连不上键盘。"),
        ["panel.vendor.step1"] = ("Quit {0} (notification area icon → Exit, or Task Manager).", "退出 {0}（通知区域图标 → 退出，或在「任务管理器」里结束）。"),
        ["panel.vendor.step2"] = ("Keys reconnect automatically once it's closed.", "关掉后键盘会自动重新连接。"),
        ["panel.vendor.step3"] = ("You can reopen it after you quit RGBPrompt Player.", "退出 RGBPrompt Player 后可以再打开它。"),
        ["panel.vendor.openTaskManager"] = ("Open Task Manager", "打开任务管理器"),
        ["settings.brightness.value"] = ("{0}%", "{0}%"),
        ["settings.launch.hint"] = ("Lives in the notification area, not the taskbar", "放在通知区域，不占任务栏"),
        ["settings.preference.sound"] = ("Sound source", "声音来源"),
        ["settings.sound.off"] = ("Off", "关闭"),
        ["setup.failed.1"] = ("The download failed. Check your connection and try again.", "下载失败，请检查网络后再试。"),
        ["setup.failed.2"] = ("The downloaded file failed verification and was deleted.", "下载的文件没有通过校验，已删除。"),
        ["setup.failed.3"] = ("The driver is installed but didn't start.", "驱动装好了，但没能启动。"),
    };
}
