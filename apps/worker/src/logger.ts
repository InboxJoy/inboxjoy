type LogContext = Record<string, unknown>;

function write(level: "info" | "warn" | "error", message: string, context?: LogContext): void {
  const line = {
    level,
    message,
    time: new Date().toISOString(),
    ...context
  };

  console[level === "error" ? "error" : "log"](JSON.stringify(line));
}

export const logger = {
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, context?: LogContext) => write("error", message, context)
};
