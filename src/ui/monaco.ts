// @ts-expect-error Vite turns Monaco's worker entry into a Worker constructor.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

(globalThis as typeof globalThis & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { editor } from "monaco-editor/editor/editor.api.js";
