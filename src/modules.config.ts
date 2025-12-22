import { M_handwriting } from "./handwriting/module-handwriting";

// 模块配置接口
export interface ModuleConfig {
    [key: string]: {
        class: any;
        name: string;
        settingKey: string;
        logMessage: string;
    };
}

// 所有可用模块的配置
export const MODULE_CONFIG: ModuleConfig = {
    M_handwriting: {
        class: M_handwriting,
        name: 'M_handwriting',
        settingKey: 'handwriting-enable',
        logMessage: '画板模块加载'
    },
};

// 导出所有模块类型
export type ModuleClasses = {
    M_handwriting?: M_handwriting;
};
