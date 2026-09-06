/**
 * 跨端打开入口：按前端类型把「打开白板 / 打开文档」路由到对应实现。
 *
 * 背景：思源移动端构建中 openTab/addTab 均为空操作（思源源码 plugin/API.ts、
 * plugin/index.ts 的 /// #if MOBILE 分支），因此：
 * - 打开白板：桌面走 openTab custom 页签；移动端走全屏覆盖层（mobile-whiteboard-overlay）。
 * - 打开文档：桌面走 openTab doc；移动端走 openMobileFileById（官方移动端 API）。
 *
 * 注意：本模块严禁静态引入 mobile-whiteboard-overlay / tldraw-manager 等画布模块，
 * 否则 ui-overrides 画布组件静态引用本模块时会形成循环依赖。覆盖层一律动态 import。
 */

import { getFrontend, openMobileFileById, openTab, type App } from "siyuan";

/** 是否为思源移动端前端（App 内嵌 WebView 或移动端浏览器） */
export function isMobileFrontend(): boolean {
    try {
        const frontend = getFrontend();
        return frontend === "mobile" || frontend === "browser-mobile";
    } catch {
        return false;
    }
}

export interface OpenWhiteboardOptions {
    title?: string;
    /** 打开后定位到的思源块 id */
    blockid?: string;
    /** 打开后定位到的 tldraw 形状 id */
    shapeid?: string;
}

/**
 * 打开一块白板。
 * 桌面端：等价于原先各处的 openTab({custom: ...})；移动端：打开全屏覆盖层。
 * 返回 true 表示路由成功。
 */
export async function openWhiteboardBoard(
    plugin: { app: App, name: string },
    rootid: string,
    options: OpenWhiteboardOptions = {}
): Promise<boolean> {
    if (!rootid) return false;
    if (isMobileFrontend()) {
        const { mobileWhiteboardOverlay } = await import("../mobile-whiteboard-overlay");
        await mobileWhiteboardOverlay.open(rootid, options);
        return true;
    }
    await openTab({
        app: plugin.app,
        custom: {
            id: plugin.name + "steveTool-whiteboard",
            title: options.title || `画板${rootid}`,
            icon: "iconSTWhiteboard",
            data: {
                text: "steveTool-whiteboard" + rootid,
                rootid: rootid,
            },
        },
    });
    return true;
}

/**
 * 打开一篇思源文档。
 * 桌面端：openTab({doc: ...})；移动端：openMobileFileById。
 */
export function openSiYuanDoc(app: App, docId: string): void {
    if (!docId) return;
    if (isMobileFrontend()) {
        openMobileFileById(app, docId, ["cb-get-hl", "cb-get-all"]);
        return;
    }
    void openTab({
        app,
        doc: {
            id: docId,
            action: ["cb-get-hl", "cb-get-all"],
            zoomIn: false,
        },
        keepCursor: false,
    });
}

/**
 * 关闭移动端正在展示的白板覆盖层。
 * 典型场景：白板被移入回收站时，避免覆盖层里的实例继续自动保存把文件写回。
 * 非移动端或覆盖层未展示时为空操作。
 */
export async function closeMobileWhiteboard(rootid?: string): Promise<void> {
    if (!isMobileFrontend()) return;
    const { mobileWhiteboardOverlay } = await import("../mobile-whiteboard-overlay");
    if (rootid && mobileWhiteboardOverlay.getActiveRootid() !== rootid) return;
    if (!mobileWhiteboardOverlay.isOpen()) return;
    await mobileWhiteboardOverlay.close();
}
