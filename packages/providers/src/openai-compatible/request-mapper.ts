import type {
    ModelItem,
    ModelMessage,
    ModelRequest,
    ModelTool,
    ModelToolCall,
    ModelToolResult,
} from "@akkco/models";

export interface OpenAIFunctionCall {
    name: string;
    arguments: string;
}

export interface OpenAIToolCall {
    id: string;
    type: "function";
    function: OpenAIFunctionCall;
}

export interface OpenAITool {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export type OpenAIMessage =
    | {
          role: "system" | "user";
          content: string;
      }
    | {
          role: "assistant";
          content: string | null;
          tool_calls?: OpenAIToolCall[];
      }
    | {
          role: "tool";
          tool_call_id: string;
          content: string;
      };

export interface OpenAIRequestBody {
    model: string;
    messages: OpenAIMessage[];
    stream: true;
    tools?: OpenAITool[];
}

const serializeArguments = (args: unknown): string => JSON.stringify(args ?? {});

export const mapModelItemToOpenAIMessage = (item: ModelItem): OpenAIMessage => {
    switch (item.type) {
        case "message": {
            const role =
                item.role === "system" &&
                (item.isPolicy === false ||
                    item.provenance?.source === "memory" ||
                    item.provenance?.source === "repository")
                    ? "user"
                    : item.role;
            return {
                role,
                content: item.content,
            };
        }
        case "tool_call":
            return {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: item.id,
                        type: "function",
                        function: {
                            name: item.name,
                            arguments: serializeArguments(item.arguments),
                        },
                    },
                ],
            };
        case "tool_result":
            return {
                role: "tool",
                tool_call_id: item.callId,
                content: item.content,
            };
    }
};

export const mapModelItemsToOpenAIMessages = (items: readonly ModelItem[]): OpenAIMessage[] => {
    const messages: OpenAIMessage[] = [];
    let i = 0;

    while (i < items.length) {
        const item = items[i];

        if (item.type === "message") {
            if (item.role === "assistant") {
                const toolCalls: OpenAIToolCall[] = [];
                let j = i + 1;
                while (j < items.length && items[j].type === "tool_call") {
                    const tc = items[j] as ModelToolCall;
                    toolCalls.push({
                        id: tc.id,
                        type: "function",
                        function: {
                            name: tc.name,
                            arguments: serializeArguments(tc.arguments),
                        },
                    });
                    j++;
                }

                if (toolCalls.length > 0) {
                    messages.push({
                        role: "assistant",
                        content: item.content || null,
                        tool_calls: toolCalls,
                    });
                    i = j;
                    continue;
                }

                messages.push({
                    role: "assistant",
                    content: item.content,
                });
                i++;
                continue;
            }

            const role =
                item.role === "system" &&
                (item.isPolicy === false ||
                    item.provenance?.source === "memory" ||
                    item.provenance?.source === "repository")
                    ? "user"
                    : item.role;

            messages.push({
                role,
                content: item.content,
            });
            i++;
            continue;
        }

        if (item.type === "tool_call") {
            const toolCalls: OpenAIToolCall[] = [];
            let j = i;
            while (j < items.length && items[j].type === "tool_call") {
                const tc = items[j] as ModelToolCall;
                toolCalls.push({
                    id: tc.id,
                    type: "function",
                    function: {
                        name: tc.name,
                        arguments: serializeArguments(tc.arguments),
                    },
                });
                j++;
            }

            messages.push({
                role: "assistant",
                content: null,
                tool_calls: toolCalls,
            });
            i = j;
            continue;
        }

        if (item.type === "tool_result") {
            messages.push({
                role: "tool",
                tool_call_id: item.callId,
                content: item.content,
            });
            i++;
            continue;
        }

        i++;
    }

    return messages;
};

export const mapModelToolsToOpenAITools = (tools: ModelTool[]): OpenAITool[] =>
    tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }));

export const mapModelRequestToOpenAIPayload = (
    request: ModelRequest,
    model: string,
): OpenAIRequestBody => {
    const payload: OpenAIRequestBody = {
        model,
        messages: mapModelItemsToOpenAIMessages(request.items),
        stream: true,
    };

    if (request.tools && request.tools.length > 0) {
        payload.tools = mapModelToolsToOpenAITools(request.tools);
    }

    return payload;
};
