import { Text } from "ink";
import type { CliMetadata, CliViewState } from "../state/types.js";
import { palette } from "../theme/palette.js";
import { fitLine, uiStatus } from "../ui/layout.js";

const getStatusColor = (status: string, stateStatus: CliViewState["status"]) => {
    if (status === "Error") {
        return palette.error;
    }

    if (status === "Cancelled" || stateStatus !== "idle") {
        return palette.warning;
    }

    return palette.success;
};

const getContextHint = (offset: number | undefined, columns: number) => {
    if (offset && offset > 0) {
        return ` · Response ↑${offset} · PgDn/↓: latest`;
    }

    if (columns >= 100) {
        return " · / commands · scroll to explore";
    }

    if (columns >= 70) {
        return " · / commands";
    }

    return "";
};

export const StatusBar = ({
    metadata,
    state,
    columns,
    offset,
}: {
    metadata: CliMetadata;
    state: CliViewState;
    columns: number;
    offset?: number;
}) => {
    const queued = state.queuedPrompts?.length ?? 0;
    const status = `${uiStatus(state)}${queued ? ` · ${queued} queued` : ""}`;
    const color = getStatusColor(uiStatus(state), state.status);
    const context =
        state.status !== "idle" && !offset
            ? " · Enter: queue · Ctrl+C: cancel"
            : getContextHint(offset, columns);

    const toolModeDetail = columns >= 40 ? ` · ${metadata.toolMode}` : "";
    const providerDetail = columns >= 90 ? ` · ${metadata.provider}` : "";
    const details = `${metadata.model}${toolModeDetail}${providerDetail}${context}`;

    return (
        <Text wrap="truncate-end">
            <Text color={color}>● {status}</Text>
            <Text dimColor>
                {fitLine(` · ${details}`, Math.max(0, columns - status.length - 2))}
            </Text>
        </Text>
    );
};
