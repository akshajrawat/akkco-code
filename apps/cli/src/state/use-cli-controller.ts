import { useSyncExternalStore } from "react";
import type { CliController } from "./cli-controller.js";

export const useCliController = (controller: CliController) => {
    return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
};
