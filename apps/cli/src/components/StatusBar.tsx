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

const getContextHint = (offset: number, columns: number) => {
    if (offset > 0) {
        return ` · History ↑${offset} · PgDn/↓: latest`;
    }

    if (columns >= 100) {
        return " · /tools /clear /exit · PgUp/↑";
    }

    if (columns >= 70) {
        return " · /exit · PgUp/↑";
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
    offset: number;
}) => {
    const status = uiStatus(state);
    const color = getStatusColor(status, state.status);
    const context = getContextHint(offset, columns);

    const toolModeDetail = columns >= 40 ? ` · ${metadata.toolMode}` : "";
    const providerDetail = columns >= 90 ? ` · ${metadata.provider}` : "";
    const details = `${metadata.model}${toolModeDetail}${providerDetail}${context}`;

    return (
        <Text wrap="truncate-end">
            <Text color={color}>{status}</Text>
            <Text dimColor>{fitLine(` · ${details}`, Math.max(0, columns - status.length))}</Text>
        </Text>
    );
};
