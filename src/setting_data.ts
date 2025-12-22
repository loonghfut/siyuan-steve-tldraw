
import { handwritingDefaults } from "./settings/handwriting";

import { commonDefaults } from "./settings/common";


// 聚合所有模块默认配置
export const defaultSettings: Record<string, any> = {

    ...handwritingDefaults,

    ...commonDefaults,

};

export function getSettings() { return { ...defaultSettings }; }
export function resetSettings() { return { ...defaultSettings }; }