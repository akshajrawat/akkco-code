import type { ModelEvent } from "./events.js";
import type { ModelRequest } from "./request.js";

export interface ModelProvider {
    readonly id: string;
    stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
