/**
 * 移动端白板全屏覆盖层。
 *
 * 思源移动端构建中 openTab/addTab 均为空操作（见思源源码 plugin/API.ts 与 plugin/index.ts
 * 的 /// #if MOBILE 分支），无法通过自定义页签承载白板。因此移动端改用挂在
 * document.body 上的全屏覆盖层来容纳 TldrawManager。
 *
 * 关键点：
 * - 覆盖层标记 data-prevent-swipe="true"，思源移动端的全局 touch 手势（侧栏滑动、
 *   前进后退）会因此跳过处理（见思源源码 mobile/util/touch.ts handleTouchStart）。
 * - z-index 走 window.siyuan.zIndex 自增序列，保证后续弹出的对话框/菜单/键盘工具条
 *   仍能盖在白板之上。
 * - 同一时刻只承载一块白板；切换白板前会 await 旧 manager.destroy()（内部先保存数据）。
 *   open() 通过 promise 链串行化，避免并发打开产生未销毁的僵尸实例；
 *   await 期间覆盖层可能已被 close() 移除，恢复执行后必须重新校验存活。
 */

import { showMessage } from "siyuan";
import type { TLShapeId } from "@tldraw/tldraw";
import { TldrawManager } from "./tldraw-manager";
import "./mobile-whiteboard-overlay.scss";

const OVERLAY_CLASS = "st-mobile-whiteboard";
const NAVIGATE_RETRY_INTERVAL = 200;
const NAVIGATE_TOTAL_WAIT = 6000;

export interface MobileWhiteboardOpenOptions {
    /** 白板标题（覆盖层头部展示），缺省时同板保留现标题、换板退回「画板 {rootid}」 */
    title?: string;
    /** 打开后需要定位到的思源块 id */
    blockid?: string;
    /** 打开后需要定位到的 tldraw 形状 id */
    shapeid?: string;
}

class MobileWhiteboardOverlay {
    private element: HTMLElement | null = null;
    private bodyElement: HTMLElement | null = null;
    private titleElement: HTMLElement | null = null;
    private manager: TldrawManager | null = null;
    private rootid: string | null = null;
    private navigateTimer: number | null = null;
    // open() 串行化链：销毁旧实例是异步过程，排队避免并发打开交叉产生僵尸实例
    private openChain: Promise<void> = Promise.resolve();

    isOpen(): boolean {
        return !!this.element;
    }

    getActiveRootid(): string | null {
        return this.rootid;
    }

    getActiveManager(): TldrawManager | null {
        return this.manager;
    }

    open(rootid: string, options: MobileWhiteboardOpenOptions = {}): Promise<void> {
        const task = this.openChain.then(() => this.doOpen(rootid, options));
        // 链上吞掉异常，保证一次失败不阻塞后续排队
        this.openChain = task.then(() => undefined, () => undefined);
        return task;
    }

    private async doOpen(rootid: string, options: MobileWhiteboardOpenOptions): Promise<void> {
        if (!rootid) return;

        if (this.isOpen() && this.rootid === rootid) {
            this.setTitle(options.title);
            if (options.blockid || options.shapeid) {
                this.navigateTo(options.blockid, options.shapeid);
            }
            return;
        }

        this.ensureShell();
        this.show();
        this.setTitle(this.resolveTitle(rootid, options.title));

        // 切换白板前先销毁旧实例，destroy 内部会保存数据（并取消未完成的导航重试）
        await this.destroyManager();

        // 等待期间覆盖层可能已被 close()（返回按钮/插件卸载）移除
        if (!this.element || !this.bodyElement) return;

        this.rootid = rootid;
        const body = this.bodyElement;
        body.innerHTML = '';
        const manager = new TldrawManager(rootid, body, [rootid], this.getTitle());
        this.manager = manager;
        // 与桌面 Tab 保持一致：外部可通过 panelElement.tldrawManager 取到实例
        (this.element as any).tldrawManager = manager;

        if (options.blockid || options.shapeid) {
            this.navigateTo(options.blockid, options.shapeid);
        }
    }

    /** 关闭并销毁当前白板（manager.destroy 内部会保存数据） */
    async close(): Promise<void> {
        this.cancelNavigate();
        await this.destroyManager();
        this.rootid = null;
        if (this.element) {
            this.element.remove();
            this.element = null;
            this.bodyElement = null;
            this.titleElement = null;
        }
    }

    /** 插件卸载时的清理入口 */
    async destroy(): Promise<void> {
        await this.close();
    }

    private ensureShell() {
        if (this.element) return;
        const element = document.createElement('div');
        element.className = OVERLAY_CLASS;
        // 思源移动端 touch 手势放行标记：内部滑动交给 tldraw 自己处理
        element.setAttribute('data-prevent-swipe', 'true');

        const header = document.createElement('div');
        header.className = `${OVERLAY_CLASS}__header`;

        const backButton = document.createElement('button');
        backButton.className = `${OVERLAY_CLASS}__back`;
        backButton.type = 'button';
        backButton.setAttribute('aria-label', '返回');
        backButton.innerHTML = '<svg><use xlink:href="#iconBack"></use></svg>';
        backButton.addEventListener('click', () => {
            void this.close();
        });

        const title = document.createElement('div');
        title.className = `${OVERLAY_CLASS}__title`;

        header.appendChild(backButton);
        header.appendChild(title);

        const body = document.createElement('div');
        body.className = `${OVERLAY_CLASS}__body`;

        element.appendChild(header);
        element.appendChild(body);
        document.body.appendChild(element);

        this.element = element;
        this.bodyElement = body;
        this.titleElement = title;
    }

    private show() {
        if (!this.element) return;
        // 参与思源的 z-index 自增序列，保证对话框/菜单/键盘工具条可以盖在白板上方
        this.element.style.zIndex = String(++window.siyuan.zIndex);
    }

    /** 换板且未传标题时退回占位标题，避免残留上一个画板的标题 */
    private resolveTitle(rootid: string, title?: string): string {
        if (title) return title;
        if (this.rootid === rootid) return this.getTitle();
        return `画板 ${rootid}`;
    }

    private setTitle(title?: string) {
        if (!this.titleElement) return;
        this.titleElement.textContent = title || this.getTitle();
    }

    private getTitle(): string {
        return this.titleElement?.textContent?.trim() || '白板';
    }

    private async destroyManager() {
        this.cancelNavigate();
        const manager = this.manager;
        this.manager = null;
        if (!manager) return;
        try {
            await manager.destroy();
        } catch (error) {
            console.warn('销毁移动端白板实例失败:', error);
            showMessage('关闭白板时保存数据失败', 3000, 'error');
        }
    }

    /**
     * 打开（或切换）后定位到指定块/形状。
     * TldrawManager 构造是异步初始化（编辑器实例晚于构造函数就绪），
     * 且形状可能懒加载，因此轮询重试直到导航成功或超时。
     */
    private navigateTo(blockid?: string, shapeid?: string) {
        if (!blockid && !shapeid) return;
        this.cancelNavigate();
        const startedAt = Date.now();
        const attempt = () => {
            const manager = this.manager;
            if (!manager) return; // 覆盖层已切换/关闭，放弃导航
            let ok = false;
            if (shapeid) {
                ok = manager.navigateToBlockShape(blockid || '', shapeid as TLShapeId);
            } else {
                ok = manager.navigateToBlockShape(blockid!);
            }
            if (ok) {
                this.navigateTimer = null;
                return;
            }
            if (Date.now() - startedAt >= NAVIGATE_TOTAL_WAIT) {
                this.navigateTimer = null;
                return;
            }
            this.navigateTimer = window.setTimeout(attempt, NAVIGATE_RETRY_INTERVAL);
        };
        this.navigateTimer = window.setTimeout(attempt, NAVIGATE_RETRY_INTERVAL);
    }

    private cancelNavigate() {
        if (this.navigateTimer !== null) {
            window.clearTimeout(this.navigateTimer);
            this.navigateTimer = null;
        }
    }
}

export const mobileWhiteboardOverlay = new MobileWhiteboardOverlay();
