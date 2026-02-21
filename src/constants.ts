export const TOOL_SCHEMAS: Record<string, { required: string[]; usage: string }> = {
  read: {
    required: ["path"],
    usage: 'read({ path: "path/to/file" })',
  },
  edit: {
    required: ["path", "old_string", "new_string"],
    usage: 'edit({ path: "file.ts", old_string: "old code", new_string: "new code" })',
  },
  write: {
    required: ["path", "content"],
    usage: 'write({ path: "file.ts", content: "file content" })',
  },
  exec: {
    required: ["command"],
    usage: 'exec({ command: "ls -la" })',
  },
};

export const PARAM_ALIASES: Record<string, string[]> = {
  path: ["path", "file_path"],
  old_string: ["old_string", "oldText"],
  new_string: ["new_string", "newText"],
};
