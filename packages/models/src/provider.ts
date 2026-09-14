import { ModelEvent, ModelRequest } from "./types.js";

export interface ModelProvider {
    readonly id: string;
    stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}