import type { BuildContext, SettingGroupDefinition } from "./types";

import { handwritingGroup } from "./handwriting";

import { commonGroup } from "./common";

export * from "./types";

export function buildSettingGroups(ctx: BuildContext): SettingGroupDefinition[] {
    return [
    handwritingGroup(ctx),
    commonGroup(ctx),
    ];
}
