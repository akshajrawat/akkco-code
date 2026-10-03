export type TerminalInputEvent =
    | { type: "text" | "paste"; text: string }
    | {
          type: "key";
          key:
              | "enter"
              | "interrupt"
              | "backspace"
              | "delete"
              | "left"
              | "right"
              | "up"
              | "down"
              | "home"
              | "end"
              | "clear"
              | "pageUp"
              | "pageDown";
      }
    | {
          type: "scroll";
          direction: "up" | "down";
          lines?: number;
      };

const pasteStart = "\x1b[200~";
const pasteEnd = "\x1b[201~";

const sequences: Record<string, Extract<TerminalInputEvent, { type: "key" }>["key"]> = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x1bOA": "up",
    "\x1bOB": "down",
    "\x1bOC": "right",
    "\x1bOD": "left",
    "\x1b[5~": "pageUp",
    "\x1b[6~": "pageDown",
    "\x1b[5;2~": "pageUp",
    "\x1b[6;2~": "pageDown",
    "\x1b[5;5~": "pageUp",
    "\x1b[6;5~": "pageDown",
    "\x1b[5;3~": "pageUp",
    "\x1b[6;3~": "pageDown",
    "\x1b[[5~": "pageUp",
    "\x1b[[6~": "pageDown",
    "\x1b[V": "pageUp",
    "\x1b[U": "pageDown",
    "\x1b[1;2A": "up",
    "\x1b[1;2B": "down",
    "\x1b[1;5A": "pageUp",
    "\x1b[1;5B": "pageDown",
    "\x1b[H": "home",
    "\x1b[F": "end",
    "\x1bOH": "home",
    "\x1bOF": "end",
    "\x1b[1~": "home",
    "\x1b[4~": "end",
    "\x1b[7~": "home",
    "\x1b[8~": "end",
    "\x1b[3~": "delete",
    "\r": "enter",
    "\n": "enter",
    "\x03": "interrupt",
    "\x7f": "backspace",
    "\b": "backspace",
    "\x01": "home",
    "\x05": "end",
    "\x15": "clear",
};

const sortedSequenceKeys = Object.keys(sequences).sort((a, b) => b.length - a.length);

export const cleanPaste = (text: string) =>
    text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

export const createTerminalInput = (onEvent: (event: TerminalInputEvent) => void) => {
    let buffer = "";
    let pasting = false;

    return (chunk: string) => {
        // Unbracketed multiline input in one chunk is also a draft, never multiple turns.
        if (
            !pasting &&
            !buffer &&
            chunk.length > 1 &&
            /[\r\n]/.test(chunk) &&
            !chunk.includes("\x1b")
        ) {
            onEvent({ type: "paste", text: cleanPaste(chunk) });
            return;
        }

        buffer += chunk;

        while (buffer) {
            if (pasting) {
                const end = buffer.indexOf(pasteEnd);
                if (end === -1) {
                    return;
                }

                onEvent({ type: "paste", text: cleanPaste(buffer.slice(0, end)) });
                buffer = buffer.slice(end + pasteEnd.length);
                pasting = false;
                continue;
            }

            if (buffer.startsWith(pasteStart)) {
                buffer = buffer.slice(pasteStart.length);
                pasting = true;
                continue;
            }

            // SGR mouse mode: \x1b[<button;col;row[M|m]
            const sgrMatch = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buffer);
            if (sgrMatch) {
                const button = parseInt(sgrMatch[1], 10);
                if ((button & 64) !== 0) {
                    const isUp = (button & 1) === 0;
                    onEvent({ type: "scroll", direction: isUp ? "up" : "down", lines: 3 });
                }

                buffer = buffer.slice(sgrMatch[0].length);
                continue;
            }

            // Incomplete SGR mouse sequence waiting for more data
            if (/^\x1b\[<\d*(?:;\d*){0,2}$/.test(buffer)) {
                return;
            }

            // X10 mouse tracking: \x1b[M followed by 3 bytes
            if (buffer.startsWith("\x1b[M")) {
                if (buffer.length < 6) {
                    return;
                }

                const cb = buffer.charCodeAt(3);
                if (cb === 96) {
                    onEvent({ type: "scroll", direction: "up", lines: 3 });
                } else if (cb === 97) {
                    onEvent({ type: "scroll", direction: "down", lines: 3 });
                }

                buffer = buffer.slice(6);
                continue;
            }

            const sequence = sortedSequenceKeys.find((key) => buffer.startsWith(key));
            if (sequence) {
                onEvent({ type: "key", key: sequences[sequence]! });
                buffer = buffer.slice(sequence.length);
                continue;
            }

            if ([pasteStart, ...sortedSequenceKeys].some((key) => key.startsWith(buffer))) {
                return;
            }

            if (buffer[0] === "\x1b") {
                const unknown = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(buffer);
                buffer = buffer.slice(unknown?.[0].length ?? 1);
                continue;
            }

            const text = /^[^\u0000-\u001f\u007f]+/.exec(buffer)?.[0];
            if (text) {
                onEvent({ type: "text", text });
                buffer = buffer.slice(text.length);
            } else {
                buffer = buffer.slice(1);
            }
        }
    };
};
