export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code = "AIO-WORKSPACE",
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
