import process from "node:process";

const origEmitWarning = process.emitWarning;

process.emitWarning = function (warning: string | Error, ...args: unknown[]) {
    if (typeof warning === "string" && warning.includes("SQLite")) {
        return;
    }
    if (
        warning &&
        typeof warning === "object" &&
        "message" in warning &&
        typeof (warning as { message: unknown }).message === "string" &&
        (warning as { message: string }).message.includes("SQLite")
    ) {
        return;
    }
    return Reflect.apply(origEmitWarning, process, [warning, ...args]);
};
