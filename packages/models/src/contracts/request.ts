import type { ModelItem } from "./items.js";
import type { ModelTool } from "./tools.js";

export interface ModelRequest {
    items: ModelItem[];
    tools?: ModelTool[];
    signal?: AbortSignal;
}
