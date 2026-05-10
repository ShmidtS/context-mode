// Fallback type declarations for packages whose .d.mts / .d.ts files
// may not be picked up by all IDE TypeScript language server versions.
// These declarations are redundant when the real types resolve correctly.

declare module "@clack/prompts" {
  export function intro(msg: string): void;
  export function outro(msg: string): void;
  export const log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    success(msg: string): void;
    step(msg: string): void;
  };
  export function note(message: string, title?: string): void;
  export function spinner(): {
    start(msg?: string): void;
    stop(msg?: string): void;
  };
  export const cancel: symbol;
  export function isCancel(value: unknown): value is typeof cancel;
  export function group<T>(opts: Record<string, unknown>): Promise<T>;
  export function text(opts: Record<string, unknown>): Promise<string | typeof cancel>;
  export function select<T>(opts: Record<string, unknown>): Promise<T | typeof cancel>;
  export function multiselect<T>(opts: Record<string, unknown>): Promise<T[] | typeof cancel>;
  export function confirm(opts: Record<string, unknown>): Promise<boolean | typeof cancel>;
}

declare module "picocolors" {
  function color(text: string): string;
  namespace color {
    export const black: (text: string) => string;
    export const red: (text: string) => string;
    export const green: (text: string) => string;
    export const yellow: (text: string) => string;
    export const blue: (text: string) => string;
    export const magenta: (text: string) => string;
    export const cyan: (text: string) => string;
    export const white: (text: string) => string;
    export const gray: (text: string) => string;
    export const dim: (text: string) => string;
    export const bgRed: (text: string) => string;
    export const bgGreen: (text: string) => string;
    export const bgYellow: (text: string) => string;
    export const bgBlue: (text: string) => string;
    export const bgMagenta: (text: string) => string;
    export const bgCyan: (text: string) => string;
    export const bgWhite: (text: string) => string;
    export const bgBlack: (text: string) => string;
  }
  export = color;
}
