import { moduleInstances } from "@/index";
import { openWhiteboardBoard } from "@/handwriting/tldraw/utils/mobile-open";

// 添加白板按钮到文档树条目
export function addWhiteboardButtonToFileTreeItem(item: Element) {
    // 检查是否已经是白板条目或者已经存在按钮
    if (item.getAttribute('data-type') === 'navigation-whiteboard' || item.querySelector('.st-whiteboard-tree-icon')) {
        return;
    }

    // 获取文档的 rootid，通常在 data-id 或 data-node-id 属性中
    const rootid = item.getAttribute('data-id') || item.getAttribute('data-node-id') || '';
    if (!rootid) return;

    // 创建白板图标按钮
    const iconBtn = document.createElement('span');
    iconBtn.className = 'b3-list-item__action st-whiteboard-tree-icon b3-tooltips b3-tooltips__nw';
    iconBtn.setAttribute('aria-label', '打开白板');
    iconBtn.innerHTML = '<svg><use xlink:href="#iconSTWhiteboard"></use></svg>';

    // 点击事件：打开白板（移动端 openTab 为空操作，openWhiteboardBoard 会路由到全屏覆盖层）
    iconBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const textEl = item.querySelector('.b3-list-item__text');
        const titleText = textEl?.textContent || '白板';
        const plugin = moduleInstances['M_handwriting'].pluginInstance;
        await openWhiteboardBoard(plugin, rootid, { title: titleText });
    });

    // 插入到 "更多" 按钮之前
    const moreBtn = item.querySelector('span[data-type="more-root"]');
    if (moreBtn) {
        item.insertBefore(iconBtn, moreBtn);
    } else {
        // 如果没有更多按钮，插入到文本后面
        const textSpan = item.querySelector('.b3-list-item__text');
        if (textSpan && textSpan.nextSibling) {
            item.insertBefore(iconBtn, textSpan.nextSibling);
        } else {
            item.appendChild(iconBtn);
        }
    }
}

// 监听文档树变化并注入白板按钮
export function setupFileTreeObserver() {
    // 查找文档树容器
    const findFileTreeContainer = (): HTMLElement | null => {
        // 尝试多个可能的选择器
        return document.querySelector('.file-tree') ||
            document.querySelector('.sy__file') ||
            document.querySelector('#fileTree') ||
            document.querySelector('[data-type="file-tree"]') ||
            document.querySelector('.b3-list--file');
    };

    const container = findFileTreeContainer();
    if (!container) return null;

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            // 处理新增的节点
            mutation.addedNodes.forEach((node) => {
                if (node instanceof HTMLElement) {
                    // 如果是列表项，直接处理
                    if (node.classList?.contains('b3-list-item')) {
                        addWhiteboardButtonToFileTreeItem(node);
                    }
                    // 查找子节点中的列表项
                    node.querySelectorAll?.('.b3-list-item').forEach((item: Element) => {
                        addWhiteboardButtonToFileTreeItem(item);
                    });
                }
            });

            // 处理属性变化（如 data-id 更新）
            if (mutation.type === 'attributes' && mutation.attributeName === 'data-id') {
                const target = mutation.target as Element;
                if (target.classList?.contains('b3-list-item')) {
                    addWhiteboardButtonToFileTreeItem(target);
                }
            }
        });
    });

    observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-id', 'data-node-id']
    });

    // 对现有项目注入按钮
    container.querySelectorAll('.b3-list-item').forEach((item: Element) => {
        addWhiteboardButtonToFileTreeItem(item);
    });

    return observer;
}

