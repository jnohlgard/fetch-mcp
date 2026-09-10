declare module "which" {
  const which: {
    (command: string, options?: { path?: string; pathExt?: string; all?: boolean; nothrow?: boolean }): Promise<string | string[] | null>
    sync(command: string, options?: { path?: string; pathExt?: string; all?: boolean; nothrow?: boolean }): string | string[] | null
  }
  export default which
}
