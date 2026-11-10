/**
 * The parts of Herdr.app's mod runtime the claudish mod uses, declared from the `herdr.d.ts` and
 * `gpui-kit.d.ts` that Herdr.app 0.1.14 writes to `~/.config/herdr-app/`. The bundle leaves these
 * modules as imports; Herdr.app provides them when it loads `mods/claudish/main.js`.
 */

declare module "herdr" {
  export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
  }
  export function exec(
    command: string,
    args?: string[],
    options?: { cwd?: string; on?: string | null; timeout?: number }
  ): Promise<ExecResult>;
  export function hc(args: string[]): Promise<ExecResult>;
  export function home(): string;
  export function readTextFile(
    path: string,
    options?: { on?: string | null }
  ): Promise<string | null>;
  export function watchFolder(path: string): Promise<string[]>;
  export function run(name: string, args?: Record<string, unknown>): null;
  // biome-ignore lint/suspicious/noExplicitAny: Herdr declares terminals() as any[]
  export function terminals(): any[];
  export function layout(): unknown;
  export function theme(): Record<string, string>;
  export function props(): Record<string, unknown> | undefined;
  export function openOverlay(spec: Record<string, unknown>): string;
  export function closeOverlay(id: string): null;
}

declare module "gpui-kit" {
  export interface Task {
    readonly __task?: never;
  }
  export interface AsyncContext {
    notify(): void;
    spawn(body: (cx: AsyncContext) => unknown): Task;
    sleep(ms?: number): Promise<void>;
  }
  export interface NativeElement {
    [method: string]: (...args: unknown[]) => NativeElement;
  }
  export abstract class View {
    init?(props: unknown, cx: AsyncContext): void;
    close?(cx: AsyncContext): void | Promise<void>;
    abstract render(cx: AsyncContext): NativeElement | string;
  }
  export function div(): NativeElement;
}

declare module "gpui-base" {
  import type { NativeElement } from "gpui-kit";
  export function h_flex(): NativeElement;
  export function v_flex(): NativeElement;
}
