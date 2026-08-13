import { showMessage } from "siyuan";

let resizeObserver: ResizeObserver | null = null;
let resizeTimeout: number = 0;

interface DockConfig {
    position: string;
    size: { width: number; height: number };
    icon: string;
    title: string;
}

interface IframeDockOptions {
    plugin: any;
    config: DockConfig;
    type: string;
    url: string;
    emptyUrlMessage?: string;
    containerClass?: string;
    iframeStyle?: string;
    pointerEventsDelay?: number;
    zoom?: number; // 添加缩放比例
}

/**
 * 创建一个带有iframe的dock
 * @param options dock配置选项
 */
export function createIframeDock(options: IframeDockOptions) {
    const {
        plugin,
        config,
        type,
        url,
        emptyUrlMessage = "请先配置网址...",
        containerClass,
        iframeStyle = "height: 99vh ; width: 100%;  pointer-events: auto;",
        pointerEventsDelay = 300,
        zoom = 1 // 默认缩放比例为1
    } = options;

    const createIframeHTML = (containerClass: string, url: string, style: string, zoom: number) => {
        return `
        <div id="${containerClass}" class="${containerClass}">
        <iframe 
        allow="clipboard-read; clipboard-write"
        sandbox="allow-forms allow-presentation allow-same-origin allow-scripts allow-modals allow-popups" 
        src="${url}" 
        data-src="" 
        border="1" 
        frameborder="no" 
        framespacing="0" 
        allowfullscreen="true" 
        style="${style}; zoom: ${zoom};"
        >
        </iframe>
        </div>
        `;
    };

    const setupResizeObserver = (targetElement: HTMLElement) => {
        if (targetElement) {
            resizeObserver = new ResizeObserver(() => {
                (targetElement as HTMLElement).style.pointerEvents = 'none';

                clearTimeout(resizeTimeout);
                resizeTimeout = window.setTimeout(() => {
                    (targetElement as HTMLElement).style.pointerEvents = 'auto';
                }, pointerEventsDelay);
            });

            resizeObserver.observe(targetElement);
        }
    };

    return plugin.addDock({
        config,
        data: null,
        type,
        update() {
            this.element.innerHTML = createIframeHTML(
                containerClass,
                url,
                "height: 100% ; width: 100%;  pointer-events: auto;",
                zoom
            );
            const targetElement = this.element.querySelector(`#${containerClass} iframe`);
            setupResizeObserver(targetElement);
        },
        init: (dock) => {
            if (url === "") {
                showMessage(emptyUrlMessage, -1, "error");
            }
            dock.element.innerHTML = createIframeHTML(containerClass, url, iframeStyle, zoom);
            const targetElement = dock.element.querySelector(`#${containerClass} iframe`);
            setupResizeObserver(targetElement);
        },
        destroy() {
            console.debug("destroy dock:", type);
            // 断开 ResizeObserver
            if (resizeObserver) {
                resizeObserver.disconnect();
                resizeObserver = null;
            }
            // 清除定时器
            clearTimeout(resizeTimeout);
        }
    });
}


interface WebviewExtraOptions {
    enableButtons?: boolean;               // 是否启用顶部悬浮按钮 (默认 true)
    buttonTexts?: {                        // 按钮文字自定义
        copy?: string;                     // 复制(插入)按钮文字
        refresh?: string;                  // 刷新按钮文字
        dev?: string;                      // 开发者工具按钮文字 (仅当 showDevButton=true 时显示)
    };
    showDevButton?: boolean;              // 是否显示打开 DevTools 按钮 (默认 false)
    hoverThreshold?: number;               // 显示按钮时的顶部阈值 (默认 60)
    hoverHideDelay?: number;               // 鼠标离开后隐藏延迟 (默认 500ms)
    hideCSS?: string | string[];           // 需要默认注入用于隐藏的 CSS (默认 .open-wps-button 隐藏)
    injectCSS?: string | string[];         // 额外注入的 CSS 片段
    injectJS?: string | string[];          // 额外注入的 JS 片段 (字符串形式，会直接 executeJavaScript)
    disableDefaultHideCSS?: boolean;       // 是否禁用默认 hideCSS (默认 false)
    userAgent?: string;                    // 覆盖 userAgent (默认移动 UA)
    onCopy?: (ctx: { webview: any; url: string }) => Promise<void> | void;       // 自定义复制逻辑
    onRefresh?: (ctx: { webview: any }) => Promise<void> | void;                 // 自定义刷新逻辑
    onDevTools?: (ctx: { webview: any }) => Promise<void> | void;                // 自定义打开 DevTools 逻辑
    buttons?: WebviewButtonConfig[];       // 自定义按钮集合（完全自定义覆盖默认按钮）
    onRoamingIntercept?: (data: { kind: string; url: string; body: string }) => void; // 监听 /api/v3/roaming 拦截数据回调
    roamingTransportMode?: 'console' | 'poll'; // webview 与宿主数据传输模式，默认 console
    initRun?: () => void;                 // 初始化运行函数
    emulateBrowserEnv?: boolean;          // 尽量模拟真实桌面浏览器环境（默认 true）
    partition?: string;                   // webview partition（默认 persist:st-wps）
    acceptLanguages?: string;             // 语言偏好，默认 zh-CN,zh,en-US,en
    webPreferences?: string;              // 覆盖 webpreferences
    enableSleep?: boolean;                // 是否启用空闲休眠（默认 false）
    sleepMinutes?: number;                // 空闲休眠阈值（分钟，默认 10）
    sleepBlankUrl?: string;               // 休眠时加载的空白页（默认 about:blank）
}
interface WebviewButtonConfig {
    id?: string;                           // 按钮 id，不含容器前缀；最终实际 id = `${containerClass}-btn-${id}`
    text: string;                          // 按钮显示文本（可含 HTML，注意安全）
    title?: string;                        // 鼠标悬浮标题
    builtInAction?: 'copy' | 'refresh' | 'dev';  // 复用内置逻辑
    onClick?: (ctx: { webview: any; getCurrentUrl: () => string }) => Promise<void> | void; // 自定义回调
    style?: string;                        // 行内样式
    className?: string;                    // 自定义类名
    show?: boolean;                        // 是否显示 (默认 true)
    order?: number;                        // 排序 (默认 0)
}



export function getCursorBlockId() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;

    const range = selection.getRangeAt(0);
    let container = range.startContainer;

    // 如果 startContainer 是文本节点，则获取其父元素
    if (container.nodeType === Node.TEXT_NODE) {
        container = container.parentElement;
    }

    // 确保 container 是一个元素节点
    if (!(container instanceof Element)) {
        return null;
    }

    const blockElement = container.closest('.protyle-wysiwyg [data-node-id]');

    if (blockElement) {
        // console.debug(blockElement.getAttribute('data-node-id'));
        return blockElement.getAttribute('data-node-id');
    } else {
        return null;
    }
}




interface RoamingItem {
  link_id: string;
  link_url: string;
  name: string;
  file_type: string;
  file_src: string;
  time: string;
}

function normalizeToArray(input: any): any[] {
  if (Array.isArray(input)) return input;

  // 字符串：尝试 JSON 解析
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return normalizeToArray(parsed); // 递归再判
    } catch {
      return [];
    }
  }

  if (input && typeof input === 'object') {
    // 常见包裹字段
    const possibleKeys = ['data', 'list', 'items', 'records', 'result'];
    for (const k of possibleKeys) {
      if (Array.isArray((input as any)[k])) return (input as any)[k];
    }
    // 单对象当作一个元素
    return [input];
  }

  return [];
}

/**
 * 格式化时间戳为可读日期时间字符串
 * @param timestamp 毫秒级时间戳
 * @returns 格式化后的日期时间字符串，如 "2025-01-20 14:30:25"
 */
function formatTimestamp(timestamp: number | string | undefined): string {
  if (!timestamp) return '';
  const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;
  if (isNaN(ts) || ts <= 0) return '';
  try {
    const date = new Date(ts);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  } catch {
    return '';
  }
}

export function pickRoamingFields(raw: any): RoamingItem[] {
  const arr = normalizeToArray(raw);
  return arr.map(o => ({
    link_id: o?.link_id ?? '',
    link_url: o?.link_url ?? '',
    name: o?.name ?? '',
    file_type: o?.file_type ?? '',
    file_src: o?.file_src ?? '',
    time: formatTimestamp(o?.mtime),
  }));
}
