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
        case "message":
            return {
                role: item.role,
                content: item.content,
            };
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
    model: string
): OpenAIRequestBody => {
    const payload: OpenAIRequestBody = {
        model,
        messages: request.items.map(mapModelItemToOpenAIMessage),
        stream: true,
    };

    if (request.tools && request.tools.length > 0) {
        payload.tools = mapModelToolsToOpenAITools(request.tools);
    }

    return payload;
};
