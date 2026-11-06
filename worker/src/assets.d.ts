/** esbuild 以 `--loader:.css=text` 把样式文件当纯文本导入（CSP 要求内联 style）。 */
declare module '*.css' {
  const css: string;
  export default css;
}
